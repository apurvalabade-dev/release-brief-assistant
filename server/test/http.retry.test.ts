import { describe, expect, it, vi } from "vitest";
import { postJson } from "../src/llm/http.js";

const res = (status: number, body = "{}", headers: Record<string, string> = {}) => new Response(body, { status, headers });
const call = (f: ReturnType<typeof vi.fn>, sleep = vi.fn().mockResolvedValue(undefined), retries = 1) =>
  postJson(f as never, "https://x.test", { "x-api-key": "sk-secret" }, { a: 1 }, 1000, { retries, delayMs: 100, sleep });

describe("postJson retries", () => {
  it("retries once on 429 and returns the successful answer", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, "slow down")).mockResolvedValueOnce(res(200, '{"ok":true}'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await call(f, sleep)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("gives up after the retry budget and reports how many attempts were made", async () => {
    const f = vi.fn().mockImplementation(async () => res(503, "overloaded"));
    await expect(call(f)).rejects.toThrow(/HTTP 503: overloaded \(after 2 attempts\)/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors such as a bad key", async () => {
    const f = vi.fn().mockResolvedValue(res(401, "bad key"));
    const sleep = vi.fn();
    await expect(call(f, sleep)).rejects.toThrow(/HTTP 401/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors Retry-After, capped at 10 seconds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await call(vi.fn().mockResolvedValueOnce(res(429, "x", { "retry-after": "3" })).mockResolvedValueOnce(res(200)), sleep);
    expect(sleep).toHaveBeenLastCalledWith(3000);
    await call(vi.fn().mockResolvedValueOnce(res(429, "x", { "retry-after": "120" })).mockResolvedValueOnce(res(200)), sleep);
    expect(sleep).toHaveBeenLastCalledWith(10_000);
  });

  it("retries 0 times when configured to", async () => {
    const f = vi.fn().mockResolvedValue(res(429, "x"));
    await expect(call(f, undefined, 0)).rejects.toThrow(/HTTP 429/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("never retries network failures and never leaks the key", async () => {
    const f = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(call(f)).rejects.toThrow("socket hang up");
    expect(f).toHaveBeenCalledTimes(1);
    const err = await call(vi.fn().mockResolvedValue(res(500, "boom"))).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("sk-secret");
  });

  it("sends the same body on every attempt", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200));
    await call(f);
    expect(f.mock.calls[0]![1].body).toBe(f.mock.calls[1]![1].body);
  });
});
