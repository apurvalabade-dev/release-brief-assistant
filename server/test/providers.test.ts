import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { extractJson } from "../src/llm/http.js";
import { createProvider } from "../src/llm/index.js";
import type { LlmRequest } from "../src/llm/types.js";

const req: LlmRequest = { task: "analyze", system: "SYS", user: "USER", input: {} };
const okResponse = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("extractJson", () => {
  it("parses plain, fenced and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/did not contain JSON/);
  });
});

describe("Anthropic provider (stubbed fetch)", () => {
  const config = loadConfig({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_MODEL: "claude-test", LLM_RETRY_DELAY_MS: "1" });

  it("sends the key in a header, never in the URL, and parses the text block", async () => {
    const f = vi.fn().mockResolvedValue(okResponse({ content: [{ type: "text", text: '```json\n{"ok":true}\n```' }] }));
    const p = createProvider(config, f as never);
    expect(await p.completeJson(req)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(String(url)).not.toContain("sk-secret");
    expect(init.headers["x-api-key"]).toBe("sk-secret");
    expect(JSON.parse(init.body)).toMatchObject({ model: "claude-test", system: "SYS", messages: [{ role: "user", content: "USER" }] });
    expect(p.name).toBe("anthropic:claude-test");
  });

  it("raises a clear error on HTTP failure without leaking the key", async () => {
    // A fresh Response per call, like real fetch (a body can only be read once).
    const f = vi.fn().mockImplementation(async () => okResponse("rate limited", 429));
    const err = await createProvider(config, f as never).completeJson(req).catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 429");
    expect((err as Error).message).toContain("after 2 attempts");
    expect((err as Error).message).not.toContain("sk-secret");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fails on an empty or non-JSON model answer", async () => {
    await expect(createProvider(config, vi.fn().mockResolvedValue(okResponse({ content: [] })) as never).completeJson(req)).rejects.toThrow(/no text/);
    await expect(createProvider(config, vi.fn().mockResolvedValue(okResponse({ content: [{ type: "text", text: "sorry" }] })) as never).completeJson(req)).rejects.toThrow(/did not contain JSON/);
  });
});

describe("Gemini provider (stubbed fetch)", () => {
  const config = loadConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g-secret", GEMINI_MODEL: "gemini-test", LLM_RETRY_DELAY_MS: "1" });
  const answer = (text: string) => okResponse({ candidates: [{ content: { parts: [{ text }] } }] });

  it("calls generateContent with the key in a header and JSON mime type", async () => {
    const f = vi.fn().mockResolvedValue(answer('{"ok":1}'));
    expect(await createProvider(config, f as never).completeJson(req)).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(String(url)).not.toContain("g-secret");
    expect(init.headers["x-goog-api-key"]).toBe("g-secret");
    const body = JSON.parse(init.body);
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
  });

  it("reports the finish reason when nothing came back (e.g. safety block)", async () => {
    const f = vi.fn().mockResolvedValue(okResponse({ candidates: [{ finishReason: "SAFETY" }] }));
    await expect(createProvider(config, f as never).completeJson(req)).rejects.toThrow(/SAFETY/);
  });

  it("surfaces network errors", async () => {
    const f = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(createProvider(config, f as never).completeJson(req)).rejects.toThrow("socket hang up");
  });
});

describe("config for providers", () => {
  it("requires the matching key", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("treats blank values from .env.example as unset", () => {
    expect(loadConfig({ LLM_PROVIDER: "mock", ANTHROPIC_API_KEY: "" }).LLM_PROVIDER).toBe("mock");
    expect(() => loadConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
  });
  it("creates the mock provider without any key", () => {
    expect(createProvider(loadConfig({})).name).toBe("mock");
  });
});
