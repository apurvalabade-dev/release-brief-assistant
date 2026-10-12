import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { setupTestDb, type TestDb } from "./db.js";
import { goodPackage } from "./fixtures.js";

/**
 * Integration tests need a real Postgres: set TEST_DATABASE_URL.
 * Everything runs inside a throwaway schema that is dropped afterwards.
 * Use a DIRECT (non-pooled) connection string; the helper refuses pooled ones.
 */
const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("releases API (postgres)", () => {
  let db: TestDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await setupTestDb(url!);
    pool = db.pool;
    app = createApp({ pool });
  });

  afterAll(async () => {
    await db?.teardown();
  });

  const create = (name = "Acme 2.4", pkg: unknown = goodPackage()) => request(app).post("/api/releases").send({ name, package: pkg });

  it("creates a release with version 1, assigned ids and readiness checks", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.version.versionNo).toBe(1);
    expect(res.body.version.package.bugFixes[0].id).toBe("B-1");
    expect(res.body.checks.ready).toBe(true);
  });

  it("accepts an incomplete package and reports it as not ready (drafts are allowed)", async () => {
    const res = await create("Draft", {});
    expect(res.status).toBe(201);
    expect(res.body.checks.ready).toBe(false);
  });

  it("rejects invalid input with 400", async () => {
    expect((await create("")).status).toBe(400);
    expect((await create("x", { completedFeatures: [{ title: "  " }] })).status).toBe(400);
    expect((await request(app).post("/api/releases").send({})).status).toBe(400);
  });

  it("lists releases with their latest version number", async () => {
    await create("Listed");
    const res = await request(app).get("/api/releases");
    expect(res.status).toBe(200);
    expect(res.body.releases.find((r: any) => r.name === "Listed").latestVersion).toBe(1);
  });

  it("returns 404 for unknown ids and 400 for malformed ids", async () => {
    expect((await request(app).get("/api/releases/999999")).status).toBe(404);
    expect((await request(app).get("/api/releases/abc")).status).toBe(400);
    expect((await request(app).get("/api/releases/999999/versions/1")).status).toBe(404);
    expect((await request(app).post("/api/releases/999999/versions").send({ package: {} })).status).toBe(404);
  });

  it("adds immutable versions: v1 is unchanged after v2 is saved", async () => {
    const id = (await create("Versions")).body.release.id;
    const edited = goodPackage();
    edited.completedFeatures = [{ id: "F-1", title: "CSV export", description: "Export up to 50k rows" }];
    const v2 = await request(app).post(`/api/releases/${id}/versions`).send({ package: edited });
    expect(v2.status).toBe(201);
    expect(v2.body.version.versionNo).toBe(2);

    const v1 = await request(app).get(`/api/releases/${id}/versions/1`);
    expect(v1.body.version.package.completedFeatures[0].description).toBe("Export up to 10k rows");
    const rel = await request(app).get(`/api/releases/${id}`);
    expect(rel.body.versions.map((v: any) => v.versionNo)).toEqual([1, 2]);
  });

  it("does not create a version when the package is unchanged", async () => {
    const id = (await create("Same")).body.release.id;
    const res = await request(app).post(`/api/releases/${id}/versions`).send({ package: goodPackage() });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect((await request(app).get(`/api/releases/${id}`)).body.versions).toHaveLength(1);
  });

  it("diffs two versions", async () => {
    const id = (await create("Diffable")).body.release.id;
    const edited = goodPackage();
    edited.completedFeatures = [{ id: "F-1", title: "CSV export", description: "Export up to 50k rows" }];
    await request(app).post(`/api/releases/${id}/versions`).send({ package: edited });
    const res = await request(app).get(`/api/releases/${id}/diff?from=1&to=2`);
    expect(res.status).toBe(200);
    expect(res.body.diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(res.body.diff.sections[0].changed[0].id).toBe("F-1");
  });

  it("validates diff parameters and missing versions", async () => {
    const id = (await create("Diff errors")).body.release.id;
    expect((await request(app).get(`/api/releases/${id}/diff`)).status).toBe(400);
    expect((await request(app).get(`/api/releases/${id}/diff?from=1&to=9`)).status).toBe(404);
  });

  it("gives concurrent saves distinct, gapless version numbers", async () => {
    const id = (await create("Race")).body.release.id;
    const saves = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => {
        const pkg = goodPackage();
        pkg.completedFeatures = [{ id: "F-1", title: `Edit ${n}`, description: "" }];
        return request(app).post(`/api/releases/${id}/versions`).send({ package: pkg });
      }),
    );
    expect(saves.map((s) => s.status)).toEqual([201, 201, 201, 201, 201]);
    const nums = saves.map((s) => s.body.version.versionNo).sort();
    expect(nums).toEqual([2, 3, 4, 5, 6]);
  });

  it("writes audit log entries for human actions", async () => {
    const id = (await create("Audited")).body.release.id;
    const edited = goodPackage();
    edited.affectedUserGroups = ["Admins", "Clients"];
    await request(app).post(`/api/releases/${id}/versions`).send({ package: edited });
    const rows = await pool.query("SELECT actor, action FROM audit_log WHERE (detail->>'releaseId')::int = $1 ORDER BY id", [id]);
    expect(rows.rows).toEqual([
      { actor: "human", action: "release_created" },
      { actor: "human", action: "version_created" },
    ]);
  });
});

describe("without a database", () => {
  it("returns 503 for release routes", async () => {
    const res = await request(createApp()).get("/api/releases");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "database_not_configured" });
  });
});
