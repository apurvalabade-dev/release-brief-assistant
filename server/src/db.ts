import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(databaseUrl: string | undefined): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  pool ??= new pg.Pool({ connectionString: databaseUrl });
  return pool;
}
