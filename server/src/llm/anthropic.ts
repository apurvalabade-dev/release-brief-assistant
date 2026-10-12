import { extractJson, postJson, type FetchLike } from "./http.js";
import type { LlmProvider, LlmRequest } from "./types.js";

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; timeoutMs: number; retries?: number; retryDelayMs?: number; fetchImpl?: FetchLike }) {
    this.name = `anthropic:${opts.model}`;
  }

  async completeJson(req: LlmRequest): Promise<unknown> {
    const data = await postJson(
      this.opts.fetchImpl ?? fetch,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
      { model: this.opts.model, max_tokens: 4096, system: req.system, messages: [{ role: "user", content: req.user }] },
      this.opts.timeoutMs,
      { retries: this.opts.retries ?? 1, delayMs: this.opts.retryDelayMs ?? 2000 },
    );
    const text = (data?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    if (!text) throw new Error("Anthropic response had no text content");
    return extractJson(text);
  }
}
