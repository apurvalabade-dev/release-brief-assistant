import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).optional(),
  LLM_PROVIDER: z.enum(["mock", "anthropic", "gemini"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Extra attempts after a 429/5xx from the provider (0 disables retries). */
  LLM_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  LLM_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(2000),
});

export type Config = z.infer<typeof envSchema>;

/** Fails fast with a readable message if the environment is misconfigured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat blank values (e.g. "ANTHROPIC_API_KEY=" copied from .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const c = parsed.data;
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) throw new Error("Invalid environment: LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  if (c.LLM_PROVIDER === "gemini" && !c.GEMINI_API_KEY) throw new Error("Invalid environment: LLM_PROVIDER=gemini requires GEMINI_API_KEY");
  return c;
}
