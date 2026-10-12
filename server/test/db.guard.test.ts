import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDirectConnection, assertSchemaApplied } from "./db.js";

describe("test database guards", () => {
  it("rejects pooled Neon connection strings before connecting", () => {
    expect(() => assertDirectConnection("postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require")).toThrow(/pooled connection/);
  });

  it("accepts direct connection strings", () => {
    expect(() => assertDirectConnection("postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db?sslmode=require")).not.toThrow();
    expect(() => assertDirectConnection("postgres://postgres@localhost:5432/x")).not.toThrow();
  });
});

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("schema guard (postgres)", () => {
  it("refuses to proceed when search_path is not applied (simulates a pooled connection)", async () => {
    const pool = new pg.Pool({ connectionString: url, max: 3 }); // deliberately no search_path hook
    try {
      await expect(assertSchemaApplied(pool, "rb_test_does_not_exist")).rejects.toThrow(/search_path was not applied/);
    } finally {
      await pool.end();
    }
  });
});
