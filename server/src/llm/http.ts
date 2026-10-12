export type FetchLike = typeof fetch;

/** Pulls a JSON object out of model text, tolerating ```json fences and stray prose around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("model response did not contain JSON");
  }
}

export interface RetryOptions {
  /** Extra attempts after a transient failure. 0 disables retries. */
  retries: number;
  /** Base wait; attempt n waits delayMs * n unless the server sent Retry-After. */
  delayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Rate limits and transient server errors. Auth/validation errors (4xx) are never retried. */
const TRANSIENT = new Set([429, 500, 502, 503, 504, 529]);
const MAX_WAIT_MS = 10_000;

function waitMs(res: Response, attempt: number, delayMs: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const wanted = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : delayMs * attempt;
  return Math.min(wanted, MAX_WAIT_MS);
}

/**
 * POSTs JSON and returns the parsed body. Transient HTTP failures are retried a bounded number
 * of times. Errors never include request headers (they hold API keys), and network errors or
 * timeouts are not retried (a timeout already cost the full wait).
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  retry: RetryOptions = { retries: 1, delayMs: 2000 },
): Promise<any> {
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("LLM API returned a non-JSON body");
      }
    }
    if (TRANSIENT.has(res.status) && attempt <= retry.retries) {
      await sleep(waitMs(res, attempt, retry.delayMs));
      continue;
    }
    throw new Error(`LLM API returned HTTP ${res.status}: ${text.slice(0, 300)}${attempt > 1 ? ` (after ${attempt} attempts)` : ""}`);
  }
}
