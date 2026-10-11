import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("app", () => {
  const app = createApp();

  it("health check responds ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for unknown api routes", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const res = await request(app).post("/api/health").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3001);
    expect(c.LLM_PROVIDER).toBe("mock");
  });

  it("rejects an invalid provider", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "gpt" })).toThrow(/Invalid environment/);
  });

  it("requires a key when the anthropic provider is selected", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
