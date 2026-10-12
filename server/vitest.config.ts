import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests talk to a real, often remote, Postgres where one round trip can cost 100ms+.
    
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // DB-backed files each create and drop their own schema; running files one at a time keeps
    // connection counts low on small hosted databases.
    fileParallelism: false,
  },
});
