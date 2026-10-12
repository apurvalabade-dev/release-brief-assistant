import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MockProvider } from "../src/llm/mock.js";
import { setupTestDb, type TestDb } from "./db.js";
import { goodPackage } from "./fixtures.js";

const url = process.env["TEST_DATABASE_URL"];

/** A package with n features, all covered by passing QA, so generation produces ~2n+ statements. */
const bigPackage = (n: number) => {
  const features = Array.from({ length: n }, (_, i) => ({ id: `F-${i + 1}`, title: `Feature ${i + 1}`, description: "Does a thing." }));
  return { ...goodPackage(), completedFeatures: features, bugFixes: [], qaSummary: [{ id: "Q-1", summary: "Regression suite", result: "pass" as const, covers: features.map((f) => f.id) }] };
};

describe.skipIf(!url)("database round trips do not grow with the number of statements (postgres)", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = await setupTestDb(url!);
    app = createApp({ pool: db.pool, provider: new MockProvider() });
  });
  afterAll(async () => {
    await db?.teardown();
  });

  /** Counts queries sent to Postgres while fn runs. */
  async function countQueries(fn: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      await fn();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }
  const create = async (pkg: unknown) => (await request(app).post("/api/releases").send({ name: "R", package: pkg })).body.release.id as number;

  it("generating a small and a large review costs the same number of queries", async () => {
    const small = await create(bigPackage(1));
    const large = await create(bigPackage(30));
    let smallRes: request.Response | undefined;
    let largeRes: request.Response | undefined;
    const qSmall = await countQueries(async () => (smallRes = await request(app).post(`/api/releases/${small}/versions/1/generate`).send({})));
    const qLarge = await countQueries(async () => (largeRes = await request(app).post(`/api/releases/${large}/versions/1/generate`).send({})));
    expect(smallRes?.status).toBe(201);
    expect(largeRes?.status).toBe(201);
    expect(largeRes?.body.statements.length).toBeGreaterThan(60);
    expect(qLarge).toBe(qSmall);
    expect(qLarge).toBeLessThan(30);
  });

  it("carrying over a large review costs the same number of queries as a small one, and keeps every field", async () => {
    const makeV2 = async (n: number) => {
      const id = await create(bigPackage(n));
      await request(app).post(`/api/releases/${id}/versions/1/generate`).send({});
      const stmts = (await request(app).get(`/api/releases/${id}/versions/1/review`)).body.statements;
      await request(app).patch(`/api/releases/${id}/versions/1/statements/${stmts[0].id}`).send({ status: "approved" });
      const changed = bigPackage(n);
      changed.completedFeatures[0] = { id: "F-1", title: "Feature 1", description: "Changed wording." };
      await request(app).post(`/api/releases/${id}/versions`).send({ package: changed });
      return { id, before: (await request(app).get(`/api/releases/${id}/versions/1/review`)).body.statements as any[] };
    };
    const small = await makeV2(1);
    const large = await makeV2(30);
    let res: request.Response | undefined;
    const qSmall = await countQueries(async () => (res = await request(app).post(`/api/releases/${small.id}/versions/2/carry-over`).send({})));
    expect(res?.status).toBe(201);
    const qLarge = await countQueries(async () => (res = await request(app).post(`/api/releases/${large.id}/versions/2/carry-over`).send({})));
    expect(res?.status).toBe(201);
    expect(qLarge).toBe(qSmall);

    // Every carried statement keeps its text, citations, position, section and audience, in the same order.
    const after = (await request(app).get(`/api/releases/${large.id}/versions/2/review`)).body.statements as any[];
    expect(after.length).toBe(large.before.length);
    expect(after.map((s) => [s.audience, s.position, s.section, s.text, s.citations])).toEqual(large.before.map((s) => [s.audience, s.position, s.section, s.text, s.citations]));
    expect(after.filter((s) => s.freshness !== "fresh").length).toBeGreaterThan(0);
  });
});
