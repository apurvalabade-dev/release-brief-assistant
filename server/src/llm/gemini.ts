import { extractJson, postJson, type FetchLike } from "./http.js";
import type { LlmProvider, LlmRequest } from "./types.js";

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; timeoutMs: number; retries?: number; retryDelayMs?: number; fetchImpl?: FetchLike }) {
    this.name = `gemini:${opts.model}`;
  }

  async completeJson(req: LlmRequest): Promise<unknown> {
    const data = await postJson(
      this.opts.fetchImpl ?? fetch,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.opts.model)}:generateContent`,
      { "x-goog-api-key": this.opts.apiKey },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      },
      this.opts.timeoutMs,
      { retries: this.opts.retries ?? 1, delayMs: this.opts.retryDelayMs ?? 2000 },
    );
    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
    if (!text) throw new Error(`Gemini response had no text (finishReason: ${data?.candidates?.[0]?.finishReason ?? "unknown"})`);
    return extractJson(text);
  }
}
