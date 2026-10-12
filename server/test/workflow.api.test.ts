import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider } from "../src/llm/mock.js";
import { setupTestDb, type TestDb } from "./db.js";
import { goodPackage } from "./fixtures.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("human review workflow API (postgres)", () => {
  let db: TestDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await setupTestDb(url!);
    pool = db.pool;
    app = createApp({ pool, provider: new MockProvider() });
  });
  afterAll(async () => {
    await db?.teardown();
  });

  const pkgV1 = () => ({ ...goodPackage(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }, { id: "F-2", title: "Dark mode" }] });
  const api = {
    create: async (pkg: unknown = pkgV1()) => (await request(app).post("/api/releases").send({ name: "Acme", package: pkg })).body.release.id as number,
    version: (id: number, pkg: unknown) => request(app).post(`/api/releases/${id}/versions`).send({ package: pkg }),
    generate: (id: number, n = 1) => request(app).post(`/api/releases/${id}/versions/${n}/generate`).send({}),
    review: (id: number, n = 1) => request(app).get(`/api/releases/${id}/versions/${n}/review`),
    patch: (id: number, n: number, sid: number, body: object) => request(app).patch(`/api/releases/${id}/versions/${n}/statements/${sid}`).send(body),
    brief: (id: number, audience: string, n = 1) => request(app).post(`/api/releases/${id}/versions/${n}/brief`).send({ audience }),
    carry: (id: number, n: number) => request(app).post(`/api/releases/${id}/versions/${n}/carry-over`).send({}),
  };
  const approveAll = async (id: number, n = 1) => {
    const { statements } = (await api.review(id, n)).body;
    for (const s of statements) if (s.status !== "approved") expect((await api.patch(id, n, s.id, { status: "approved" })).status).toBe(200);
  };
  const auditActions = async (id: number) => (await pool.query("SELECT actor, action FROM audit_log WHERE (detail->>'releaseId')::int = $1 ORDER BY id", [id])).rows;

  it("approve and reject are human actions that land in the audit log with before/after", async () => {
    const id = await api.create();
    const { statements } = (await api.generate(id)).body;
    const [a, b] = statements;
    expect((await api.patch(id, 1, a.id, { status: "approved" })).body.statement.status).toBe("approved");
    expect((await api.patch(id, 1, b.id, { status: "rejected" })).body.statement.status).toBe("rejected");
    expect((await api.patch(id, 1, b.id, { status: "draft" })).body.statement.status).toBe("draft");
    const rows = await auditActions(id);
    expect(rows.filter((r) => r.action.startsWith("statement_")).every((r) => r.actor === "human")).toBe(true);
    const detail = await pool.query("SELECT detail FROM audit_log WHERE action = 'statement_approved' AND (detail->>'releaseId')::int = $1", [id]);
    expect(detail.rows[0].detail).toMatchObject({ statementId: a.id, before: { status: "draft" }, after: { status: "approved" } });
  });

  it("editing marks the statement human-edited and resets approval to draft", async () => {
    const id = await api.create();
    const s = (await api.generate(id)).body.statements[0];
    await api.patch(id, 1, s.id, { status: "approved" });
    const edited = await api.patch(id, 1, s.id, { text: "Reworded by a human." });
    expect(edited.body.statement).toMatchObject({ text: "Reworded by a human.", status: "draft", editedByHuman: true });
    const both = await api.patch(id, 1, s.id, { text: "Final wording.", status: "approved" });
    expect(both.body.statement).toMatchObject({ text: "Final wording.", status: "approved" });
  });

  it("validates review actions", async () => {
    const id = await api.create();
    const s = (await api.generate(id)).body.statements[0];
    expect((await api.patch(id, 1, s.id, {})).status).toBe(400);
    expect((await api.patch(id, 1, s.id, { status: "published" })).status).toBe(400);
    expect((await api.patch(id, 1, s.id, { text: "  " })).status).toBe(400);
    expect((await api.patch(id, 1, 999999, { status: "approved" })).status).toBe(404);
    const other = await api.create();
    expect((await api.patch(other, 1, s.id, { status: "approved" })).status).toBe(404); // statement belongs to another release
  });

  it("refuses to build the brief until every statement is reviewed, then builds it", async () => {
    const id = await api.create();
    await api.generate(id);
    const early = await api.brief(id, "internal");
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("review_incomplete");
    expect(early.body.problems.join(" ")).toContain("still drafts");

    await approveAll(id);
    const done = await api.brief(id, "internal");
    expect(done.status).toBe(201);
    expect(done.body.brief.content).toContain("not a deployment approval");
    expect((await api.brief(id, "stakeholder")).status).toBe(201);
    const list = await request(app).get(`/api/releases/${id}/versions/1/briefs`);
    expect(list.body.briefs.map((b: any) => b.audience)).toEqual(["stakeholder", "internal"]);
    expect((await auditActions(id)).filter((r) => r.action === "brief_generated")).toHaveLength(2);
  });

  it("blocks the brief if the risk statement for an unverified item is rejected", async () => {
    const id = await api.create();
    const { statements } = (await api.generate(id)).body;
    for (const s of statements) await api.patch(id, 1, s.id, { status: s.section === "risk" && s.audience === "internal" ? "rejected" : "approved" });
    const r = await api.brief(id, "internal");
    expect(r.status).toBe(409);
    expect(r.body.problems.join(" ")).toContain("no approved risk statement covers it");
  });

  it("carry-over keeps unchanged approvals and flags statements whose sources changed", async () => {
    const id = await api.create();
    await api.generate(id);
    await approveAll(id);
    const v2 = pkgV1();
    v2.completedFeatures[0] = { id: "F-1", title: "CSV export", description: "Export up to 50k rows" };
    expect((await api.version(id, v2)).body.version.versionNo).toBe(2);

    const carried = await api.carry(id, 2);
    expect(carried.status).toBe(201);
    expect(carried.body.summary).toMatchObject({ fromVersion: 1, stale: 2, sourceRemoved: 0 });
    expect(carried.body.summary.fresh).toBeGreaterThan(0);

    const { statements, analysis } = carried.body.review;
    expect(analysis).toBeNull();
    const stale = statements.filter((s: any) => s.freshness === "stale");
    expect(stale).toHaveLength(2);
    expect(stale.every((s: any) => s.status === "draft" && s.citations.includes("F-1"))).toBe(true);
    const fresh = statements.filter((s: any) => s.freshness === "fresh");
    expect(fresh.every((s: any) => s.status === "approved")).toBe(true);

    // Version 1 is untouched by any of this.
    expect((await api.review(id, 1)).body.statements.every((s: any) => s.freshness === "fresh" && s.status === "approved")).toBe(true);

    // A stale statement cannot simply be approved...
    const r = await api.patch(id, 2, stale[0].id, { status: "approved" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_statement");
    // ...a human has to re-confirm it by editing, which re-anchors it to the new content.
    const reconfirmed = await api.patch(id, 2, stale[0].id, { text: "Export now handles up to 50k rows.", status: "approved" });
    expect(reconfirmed.status).toBe(200);
    expect((await api.review(id, 2)).body.statements.find((s: any) => s.id === stale[0].id).freshness).toBe("fresh");
  });

  it("carry-over drops statements whose cited items were removed, and blocks the brief for uncovered new items", async () => {
    const id = await api.create();
    await api.generate(id);
    await approveAll(id);
    const v2 = { ...pkgV1(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }, { id: "F-3", title: "Audit trail", description: "Adds an audit log" }] };
    // F-2 removed, F-3 added. Give F-3 passing QA so it is not a risk item.
    (v2 as any).qaSummary = [...goodPackage().qaSummary, { id: "Q-3", summary: "Audit trail verified", result: "pass", covers: ["F-3"] }];
    await api.version(id, v2);

    const c = await api.carry(id, 2);
    expect(c.body.summary.sourceRemoved).toBeGreaterThan(0); // F-2's change + risk statements are gone
    const brief = await api.brief(id, "internal", 2);
    expect(brief.status).toBe(409);
    expect(brief.body.problems.join(" ")).toContain('F-3 "Audit trail" is not covered');

    // A human adds the missing statement; citations must be real.
    const bad = await request(app).post(`/api/releases/${id}/versions/2/statements`).send({ audience: "internal", section: "change", text: "x", citations: ["F-99"] });
    expect(bad.status).toBe(400);
    const added = await request(app).post(`/api/releases/${id}/versions/2/statements`).send({ audience: "internal", section: "change", text: "F-3 Audit trail adds an audit log. Verified by Q-3.", citations: ["F-3", "Q-3"] });
    expect(added.status).toBe(201);
    expect(added.body.statement).toMatchObject({ status: "draft", editedByHuman: true, freshness: "fresh" });
    await api.patch(id, 2, added.body.statement.id, { status: "approved" });
    // The earlier statement for the removed F-2 is gone, and the stakeholder side still lacks F-3:
    expect((await api.brief(id, "stakeholder", 2)).status).toBe(409);
  });

  it("carry-over guards: nothing to carry, and only once", async () => {
    const id = await api.create();
    await api.version(id, { ...pkgV1(), affectedUserGroups: ["Admins", "Clients"] });
    expect((await api.carry(id, 2)).body.error).toBe("nothing_to_carry");
    await api.generate(id, 1);
    expect((await api.carry(id, 2)).status).toBe(201);
    expect((await api.carry(id, 2)).body.error).toBe("already_has_statements");
    expect((await api.carry(id, 9)).status).toBe(404);
  });

  it("no endpoint lets the model or a generation set approved: fresh generations are all drafts", async () => {
    const id = await api.create();
    expect((await api.generate(id)).body.statements.every((s: any) => s.status === "draft")).toBe(true);
    expect((await api.brief(id, "internal")).status).toBe(409);
  });
});
