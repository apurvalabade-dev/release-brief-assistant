import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import type { FetchLike } from "./http.js";
import { MockProvider } from "./mock.js";
import type { LlmProvider } from "./types.js";

export function createProvider(config: Config, fetchImpl?: FetchLike): LlmProvider {
  const base = { timeoutMs: config.LLM_TIMEOUT_MS, retries: config.LLM_RETRIES, retryDelayMs: config.LLM_RETRY_DELAY_MS, ...(fetchImpl ? { fetchImpl } : {}) };
  switch (config.LLM_PROVIDER) {
    case "mock":
      return new MockProvider();
    case "anthropic":
      return new AnthropicProvider({ ...base, apiKey: config.ANTHROPIC_API_KEY!, model: config.ANTHROPIC_MODEL });
    case "gemini":
      return new GeminiProvider({ ...base, apiKey: config.GEMINI_API_KEY!, model: config.GEMINI_MODEL });
  }
}
