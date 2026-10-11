import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Applies each migrations/*.sql file once, in filename order, each in its own transaction. */
export async function migrate(client: pg.PoolClient | pg.Client): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
      logger.info("migration applied", { file });
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return applied;
}

// Run directly: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    logger.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    const applied = await migrate(client);
    logger.info("migrations complete", { applied });
  } catch (err) {
    logger.error("migration failed", { error: (err as Error).message });
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
