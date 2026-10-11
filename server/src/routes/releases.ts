import { Router, type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { runDeterministicChecks } from "../checks.js";
import { logger } from "../logger.js";
import { diffPackages } from "../diff.js";
import { GenerationError, generateReview } from "../llm/pipeline.js";
import type { LlmProvider } from "../llm/types.js";
import { parsePackage } from "../schema.js";
import * as repo from "../repo.js";

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const id = z.coerce.number().int().positive();
const createBody = z.object({ name: z.string().trim().min(1).max(200), package: z.unknown() });
const versionBody = z.object({ package: z.unknown() });
const diffQuery = z.object({ from: id, to: id });
const generateBody = z.object({ regenerate: z.boolean().default(false) });

const notFound = (res: Response, what: string) => void res.status(404).json({ error: "not_found", what });

export function releaseRoutes(pool: pg.Pool, provider?: LlmProvider): Router {
  const router = Router();

  router.post("/", wrap(async (req, res) => {
    const body = createBody.parse(req.body);
    const pkg = parsePackage(body.package ?? {});
    const created = await repo.createRelease(pool, body.name, pkg);
    res.status(201).json({ ...created, checks: runDeterministicChecks(pkg) });
  }));

  router.get("/", wrap(async (_req, res) => {
    res.json({ releases: await repo.listReleases(pool) });
  }));

  router.get("/:id", wrap(async (req, res) => {
    const release = await repo.getRelease(pool, id.parse(req.params["id"]));
    if (!release) return notFound(res, "release");
    res.json(release);
  }));

  router.post("/:id/versions", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const pkg = parsePackage(versionBody.parse(req.body).package ?? {});
    const result = await repo.addVersion(pool, releaseId, pkg);
    if (!result) return notFound(res, "release");
    res.status(result.created ? 201 : 200).json({ ...result, checks: runDeterministicChecks(result.version.package) });
  }));

  // Registered before "/:id/versions/:n" so "diff" is never read as a version number.
  router.get("/:id/diff", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const q = diffQuery.parse(req.query);
    const [a, b] = await Promise.all([repo.getVersion(pool, releaseId, q.from), repo.getVersion(pool, releaseId, q.to)]);
    if (!a || !b) return notFound(res, "version");
    res.json({ releaseId, from: q.from, to: q.to, diff: diffPackages(a.package, b.package) });
  }));

  router.post("/:id/versions/:n/generate", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    const { regenerate } = generateBody.parse(req.body ?? {});
    if (!provider) {
      res.status(503).json({ error: "llm_not_configured" });
      return;
    }
    const version = await repo.getVersion(pool, releaseId, versionNo);
    if (!version) return notFound(res, "version");

    const checks = runDeterministicChecks(version.package);
    if (!checks.ready) {
      res.status(409).json({ error: "not_ready", message: "Fix the blocking findings before generating.", checks });
      return;
    }
    if (!regenerate && (await repo.getReview(pool, releaseId, versionNo))) {
      res.status(409).json({ error: "already_generated", message: "Pass { regenerate: true } to replace untouched drafts." });
      return;
    }

    let review;
    try {
      review = await generateReview(provider, version.package, checks);
    } catch (err) {
      if (err instanceof GenerationError) {
        logger.error("generation failed", { releaseId, versionNo, message: err.message, details: err.details });
        res.status(502).json({ error: "generation_failed", message: err.message, details: err.details });
        return;
      }
      throw err;
    }

    const saved = await repo.saveReview(pool, releaseId, versionNo, checks, review, regenerate);
    if (saved === "not_found") return notFound(res, "version");
    if (saved === "exists") {
      res.status(409).json({ error: "already_generated" });
      return;
    }
    if (saved === "has_reviewed_content") {
      res.status(409).json({ error: "has_reviewed_content", message: "Some statements were already approved, rejected or edited; they will not be overwritten." });
      return;
    }
    res.status(201).json(await repo.getReview(pool, releaseId, versionNo));
  }));

  router.get("/:id/versions/:n/review", wrap(async (req, res) => {
    const review = await repo.getReview(pool, id.parse(req.params["id"]), id.parse(req.params["n"]));
    if (!review) return notFound(res, "review");
    res.json(review);
  }));

  router.get("/:id/versions/:n", wrap(async (req, res) => {
    const version = await repo.getVersion(pool, id.parse(req.params["id"]), id.parse(req.params["n"]));
    if (!version) return notFound(res, "version");
    res.json({ version, checks: runDeterministicChecks(version.package) });
  }));

  return router;
}
