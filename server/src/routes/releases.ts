import { Router, type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { runDeterministicChecks } from "../checks.js";
import { logger } from "../logger.js";
import { buildBrief } from "../brief.js";
import { diffPackages } from "../diff.js";
import { collectItems, freshness } from "../items.js";
import { GenerationError, generateReview } from "../llm/pipeline.js";
import { AUDIENCES, statementSections, type LlmProvider } from "../llm/types.js";
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
const audience = z.enum(["internal", "stakeholder"]);
const patchBody = z
  .object({ text: z.string().trim().min(1).max(2000).optional(), status: z.enum(["draft", "approved", "rejected"]).optional() })
  .refine((b) => b.text !== undefined || b.status !== undefined, "provide text and/or status");
const addStatementBody = z.object({
  audience,
  section: z.enum(statementSections),
  text: z.string().trim().min(1).max(2000),
  citations: z.array(z.string().min(1)).min(1, "a statement must cite at least one item"),
});
const briefBody = z.object({ audience });
void AUDIENCES;

const notFound = (res: Response, what: string) => void res.status(404).json({ error: "not_found", what });

/** Review as the UI needs it: statements annotated with freshness against THIS version's package, plus live checks. */
async function reviewView(pool: pg.Pool, releaseId: number, versionNo: number) {
  const [version, review] = await Promise.all([repo.getVersion(pool, releaseId, versionNo), repo.getReview(pool, releaseId, versionNo)]);
  if (!version || !review) return null;
  const items = collectItems(version.package);
  return {
    analysis: review.analysis,
    checks: runDeterministicChecks(version.package),
    statements: review.statements.map((st) => ({ ...st, freshness: freshness(st.sourceHash, st.citations, items) })),
  };
}

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
    res.status(201).json(await reviewView(pool, releaseId, versionNo));
  }));

  router.get("/:id/versions/:n/review", wrap(async (req, res) => {
    const review = await reviewView(pool, id.parse(req.params["id"]), id.parse(req.params["n"]));
    if (!review) return notFound(res, "review");
    res.json(review);
  }));

  router.get("/:id/versions/:n", wrap(async (req, res) => {
    const version = await repo.getVersion(pool, id.parse(req.params["id"]), id.parse(req.params["n"]));
    if (!version) return notFound(res, "version");
    res.json({ version, checks: runDeterministicChecks(version.package) });
  }));

  // ---- human review actions (the only way a statement can become approved) ----

  router.patch("/:id/versions/:n/statements/:sid", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    const patch = patchBody.parse(req.body);
    const version = await repo.getVersion(pool, releaseId, versionNo);
    if (!version) return notFound(res, "version");
    const r = await repo.updateStatement(pool, releaseId, versionNo, id.parse(req.params["sid"]), patch, collectItems(version.package));
    if (r.result === "not_found") return notFound(res, "statement");
    if (r.result === "stale" || r.result === "source_removed") {
      res.status(409).json({
        error: r.result === "stale" ? "stale_statement" : "source_removed",
        message: r.result === "stale" ? "The items this statement cites changed after it was written. Edit it to confirm it still holds, or reject it." : "This statement cites an item that no longer exists. Reject it.",
      });
      return;
    }
    res.json({ statement: { ...r.statement, freshness: "fresh" } });
  }));

  router.post("/:id/versions/:n/statements", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    const body = addStatementBody.parse(req.body);
    const version = await repo.getVersion(pool, releaseId, versionNo);
    if (!version) return notFound(res, "version");
    const r = await repo.addStatement(pool, releaseId, versionNo, body, collectItems(version.package));
    if (r.result === "not_found") return notFound(res, "version");
    if (r.result === "unknown_citation") {
      res.status(400).json({ error: "unknown_citation", ids: r.ids });
      return;
    }
    res.status(201).json({ statement: { ...r.statement, freshness: "fresh" } });
  }));

  router.post("/:id/versions/:n/carry-over", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    const version = await repo.getVersion(pool, releaseId, versionNo);
    if (!version) return notFound(res, "version");
    const r = await repo.carryOver(pool, releaseId, versionNo, collectItems(version.package));
    if (r.result === "not_found") return notFound(res, "version");
    if (r.result === "exists") {
      res.status(409).json({ error: "already_has_statements" });
      return;
    }
    if (r.result === "nothing_to_carry") {
      res.status(409).json({ error: "nothing_to_carry", message: "No earlier version has statements." });
      return;
    }
    res.status(201).json({ summary: r.summary, review: await reviewView(pool, releaseId, versionNo) });
  }));

  // ---- final brief: deterministic, from approved statements only ----

  router.post("/:id/versions/:n/brief", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    const { audience: aud } = briefBody.parse(req.body);
    const [release, version, review] = await Promise.all([repo.getRelease(pool, releaseId), repo.getVersion(pool, releaseId, versionNo), repo.getReview(pool, releaseId, versionNo)]);
    if (!release || !version) return notFound(res, "version");
    const result = buildBrief({
      releaseName: release.name,
      versionNo,
      audience: aud,
      pkg: version.package,
      items: collectItems(version.package),
      checks: runDeterministicChecks(version.package),
      statements: review?.statements ?? [],
    });
    if (!result.ok) {
      res.status(409).json({ error: "review_incomplete", problems: result.errors });
      return;
    }
    res.status(201).json({ brief: await repo.saveBrief(pool, releaseId, versionNo, aud, result.content) });
  }));

  router.get("/:id/versions/:n/briefs", wrap(async (req, res) => {
    const releaseId = id.parse(req.params["id"]);
    const versionNo = id.parse(req.params["n"]);
    if (!(await repo.getVersion(pool, releaseId, versionNo))) return notFound(res, "version");
    res.json({ briefs: await repo.listBriefs(pool, releaseId, versionNo) });
  }));

  return router;
}
