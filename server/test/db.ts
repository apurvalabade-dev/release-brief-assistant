import pg from "pg";
import { migrate } from "../src/migrate.js";

/** Refuses connection strings that cannot hold a per-test schema (pooled connections). */
export function assertDirectConnection(url: string): void {
  const host = new URL(url).hostname;
  if (host.includes("-pooler")) {
    throw new Error(
      `TEST_DATABASE_URL points at a pooled connection (${host}). Use the DIRECT connection string instead (the host without "-pooler"): pooled connections cannot keep a per-test schema and queries would leak into the public schema.`,
    );
  }
}

/** Proves every connection in the pool really uses the test schema, so tests can never touch "public". */
export async function assertSchemaApplied(pool: pg.Pool, schema: string): Promise<void> {
  const rows = await Promise.all(Array.from({ length: 12 }, () => pool.query("SELECT current_schema() AS s")));
  const bad = rows.filter((r) => r.rows[0].s !== schema);
  if (bad.length > 0) {
    throw new Error(`search_path was not applied on ${bad.length} of ${rows.length} connections; refusing to run tests against a shared schema. Use a direct (non-pooled) TEST_DATABASE_URL.`);
  }
}

/**
 * Creates a throwaway schema, migrates it, and returns a pool pinned to it.
 * `drop()` removes the schema and closes everything.
 */
export async function createTestSchema(url: string): Promise<{ pool: pg.Pool; schema: string; drop: () => Promise<void> }> {
  assertDirectConnection(url);
  const schema = `rb_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const drop = async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  };

  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on("connect", (c) => void c.query(`SET search_path TO ${schema}`).catch(() => {}));
  try {
    await assertSchemaApplied(pool, schema);
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  } catch (err) {
    await drop();
    throw err;
  }
  return { pool, schema, drop };
}

export interface TestDb {
  pool: pg.Pool;
  schema: string;
  teardown: () => Promise<void>;
}

/** Interface used by the integration tests: a pool pinned to a throwaway schema, plus teardown. */
export async function setupTestDb(url: string): Promise<TestDb> {
  const { pool, schema, drop } = await createTestSchema(url);
  return { pool, schema, teardown: drop };
}
