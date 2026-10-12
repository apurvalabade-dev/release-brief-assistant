import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider } from "../src/llm/mock.js";
import type { LlmProvider } from "../src/llm/types.js";
import { setupTestDb, type TestDb } from "./db.js";
import { goodPackage } from "./fixtures.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("review generation API (postgres)", () => {
  let db: TestDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const broken: LlmProvider = { name: "broken", completeJson: async () => ({ nonsense: true }) };

  beforeAll(async () => {
    db = await setupTestDb(url!);
    pool = db.pool;
    app = createApp({ pool, provider: new MockProvider() });
  });

  afterAll(async () => {
    await db?.teardown();
  });

  const create = async (pkg: unknown = goodPackage()) => (await request(app).post("/api/releases").send({ name: "R", package: pkg })).body.release.id as number;
  const generate = (id: number, body: object = {}, a = app) => request(a).post(`/api/releases/${id}/versions/1/generate`).send(body);

  it("generates draft statements for both audiences, all cited, none approved", async () => {
    const id = await create();
    const res = await generate(id);
    expect(res.status).toBe(201);
    const { statements, analysis } = res.body;
    expect(new Set(statements.map((s: any) => s.audience))).toEqual(new Set(["internal", "stakeholder"]));
    expect(statements.every((s: any) => s.status === "draft" && s.editedByHuman === false)).toBe(true);
    expect(statements.every((s: any) => s.citations.length > 0 && s.sourceHash.length === 64)).toBe(true);
    expect(analysis.model).toBe("mock");
    expect(analysis.deterministic.ready).toBe(true);
  });

  it("refuses to generate for a package that is not ready, and says why", async () => {
    const id = await create({});
    const res = await generate(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_ready");
    expect(res.body.checks.findings.length).toBeGreaterThan(0);
  });

  it("returns 409 on a second generate unless regenerate is requested", async () => {
    const id = await create();
    await generate(id);
    expect((await generate(id)).status).toBe(409);
    expect((await generate(id)).body.error).toBe("already_generated");
    expect((await generate(id, { regenerate: true })).status).toBe(201);
    const stmts = (await request(app).get(`/api/releases/${id}/versions/1/review`)).body.statements;
    const ids = stmts.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("will not overwrite statements a human has already approved or edited", async () => {
    const id = await create();
    await generate(id);
    await pool.query("UPDATE statements SET status = 'approved' WHERE id = (SELECT min(id) FROM statements WHERE version_id = (SELECT id FROM release_versions WHERE release_id = $1))", [id]);
    const res = await generate(id, { regenerate: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("has_reviewed_content");
    const stmts = (await request(app).get(`/api/releases/${id}/versions/1/review`)).body.statements;
    expect(stmts.some((s: any) => s.status === "approved")).toBe(true);
  });

  it("returns 502 with details and stores nothing when the model output is unusable", async () => {
    const id = await create();
    const res = await generate(id, {}, createApp({ pool, provider: broken }));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("generation_failed");
    expect((await request(app).get(`/api/releases/${id}/versions/1/review`)).status).toBe(404);
  });

  it("returns 503 when no provider is configured, 404 for unknown versions", async () => {
    const id = await create();
    expect((await generate(id, {}, createApp({ pool }))).status).toBe(503);
    expect((await request(app).post(`/api/releases/${id}/versions/9/generate`).send({})).status).toBe(404);
    expect((await request(app).get(`/api/releases/${id}/versions/1/review`)).status).toBe(404);
  });

  it("flags unsupported items in the stored analysis", async () => {
    const pkg = { ...goodPackage(), completedFeatures: [...goodPackage().completedFeatures, { id: "F-2", title: "Dark mode" }] };
    const id = await create(pkg);
    const res = await generate(id);
    expect(res.body.analysis.unsupportedClaims).toMatchObject([{ itemId: "F-2", source: "deterministic" }]);
    expect(res.body.statements.some((s: any) => s.section === "risk" && s.citations.includes("F-2"))).toBe(true);
  });

  it("records the generation in the audit log as a system action", async () => {
    const id = await create();
    await generate(id);
    const rows = await pool.query("SELECT actor, action FROM audit_log WHERE (detail->>'releaseId')::int = $1 AND action = 'review_generated'", [id]);
    expect(rows.rows).toEqual([{ actor: "system", action: "review_generated" }]);
  });
});
