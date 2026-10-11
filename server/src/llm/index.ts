import type { Config } from "../config.js";
import { MockProvider } from "./mock.js";
import type { LlmProvider } from "./types.js";

export function createProvider(config: Pick<Config, "LLM_PROVIDER">): LlmProvider {
  if (config.LLM_PROVIDER === "mock") return new MockProvider();
  throw new Error(`LLM provider "${config.LLM_PROVIDER}" is not implemented yet`);
}
