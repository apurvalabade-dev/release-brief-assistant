import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider } from "../src/llm/mock.js";
import { setupTestDb, type TestDb } from "./db.js";
import { goodPackage } from "./fixtures.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("staleness when QA evidence changes (postgres)", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = await setupTestDb(url!);
    app = createApp({ pool: db.pool, provider: new MockProvider() });
  });
  afterAll(async () => {
    await db?.teardown();
  });

  const v1 = () => ({ ...goodPackage(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }, { id: "F-2", title: "Dark mode", description: "Dark theme" }] });
  const review = async (id: number, n: number) => (await request(app).get(`/api/releases/${id}/versions/${n}/review`)).body;

  it("a 'not yet verified' risk statement goes stale, drops back to draft, and cannot reach a brief, once passing QA exists", async () => {
    const id = (await request(app).post("/api/releases").send({ name: "R", package: v1() })).body.release.id as number;
    await request(app).post(`/api/releases/${id}/versions/1/generate`).send({});
    for (const s of (await review(id, 1)).statements) {
      expect((await request(app).patch(`/api/releases/${id}/versions/1/statements/${s.id}`).send({ status: "approved" })).status).toBe(200);
    }

    const v2 = { ...v1(), qaSummary: [...v1().qaSummary, { id: "Q-3", summary: "Dark mode verified on all themes", result: "pass", covers: ["F-2"] }] };
    await request(app).post(`/api/releases/${id}/versions`).send({ package: v2 });
    const carry = await request(app).post(`/api/releases/${id}/versions/2/carry-over`).send({});
    expect(carry.body.summary.stale).toBeGreaterThan(0);

    const risks = (await review(id, 2)).statements.filter((s: any) => s.section === "risk");
    expect(risks.length).toBe(2);
    for (const r of risks) {
      expect(r.freshness).toBe("stale");
      expect(r.status).toBe("draft");
    }
    // Statements about the untouched feature keep their approval.
    const untouched = (await review(id, 2)).statements.find((s: any) => s.citations.length === 1 && s.citations[0] === "B-1" && s.audience === "stakeholder");
    expect(untouched).toMatchObject({ status: "approved", freshness: "fresh" });

    // The stale approval can't be re-approved blindly, and the brief is refused while it is pending.
    const stale = risks[0];
    expect((await request(app).patch(`/api/releases/${id}/versions/2/statements/${stale.id}`).send({ status: "approved" })).body.error).toBe("stale_statement");
    expect((await request(app).post(`/api/releases/${id}/versions/2/brief`).send({ audience: "stakeholder" })).status).toBe(409);

    // A human resolves it by rejecting the outdated risk statements, after which the brief no longer says "not yet verified".
    for (const r of risks) await request(app).patch(`/api/releases/${id}/versions/2/statements/${r.id}`).send({ status: "rejected" });
    for (const s of (await review(id, 2)).statements.filter((x: any) => x.status === "draft")) {
      await request(app).patch(`/api/releases/${id}/versions/2/statements/${s.id}`).send({ text: s.text, status: "approved" });
    }
    const brief = await request(app).post(`/api/releases/${id}/versions/2/brief`).send({ audience: "stakeholder" });
    expect(brief.status).toBe(201);
    expect(brief.body.brief.content).not.toContain("not yet verified");
    expect(brief.body.brief.content).toContain("Dark mode");
  });
});
