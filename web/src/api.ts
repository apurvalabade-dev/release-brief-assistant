import type { Audience, Brief, CarrySummary, Checks, PackageDiff, PackageDraft, ReleaseDetail, ReleaseSummary, Review, Statement, VersionInfo } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: any) {
    super(describe(status, body));
  }
  /** Extra detail lines (validation issues, review problems) for display under the message. */
  get details(): string[] {
    const b = this.body ?? {};
    if (Array.isArray(b.problems)) return b.problems;
    if (Array.isArray(b.details)) return b.details;
    if (Array.isArray(b.issues)) return b.issues.map((i: any) => `${(i.path ?? []).join(".")}: ${i.message}`);
    if (Array.isArray(b.checks?.findings)) return b.checks.findings.filter((f: any) => f.severity === "error").map((f: any) => f.message);
    return [];
  }
}

function describe(status: number, body: any): string {
  if (body?.message) return body.message;
  switch (body?.error) {
    case "validation_failed": return "Some fields are invalid.";
    case "not_ready": return "The package has blocking findings. Fix them first.";
    case "review_incomplete": return "The review is not complete yet.";
    case "already_generated": return "This version already has generated statements.";
    case "stale_statement": return "This statement's sources changed. Edit it to confirm it still holds, or reject it.";
    case "generation_failed": return "The AI output failed validation. Try again.";
    case "llm_not_configured": return "No AI provider is configured on the server.";
    case "database_not_configured": return "The server has no database configured.";
  }
  return `Request failed (HTTP ${status}).`;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { message: "Cannot reach the server." });
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

const v = (id: number, n: number) => `/releases/${id}/versions/${n}`;

export const api = {
  listReleases: () => call<{ releases: ReleaseSummary[] }>("GET", "/releases").then((r) => r.releases),
  createRelease: (name: string, pkg: PackageDraft) => call<{ release: { id: number; name: string }; version: VersionInfo; checks: Checks }>("POST", "/releases", { name, package: pkg }),
  getRelease: (id: number) => call<ReleaseDetail>("GET", `/releases/${id}`),
  getVersion: (id: number, n: number) => call<{ version: VersionInfo; checks: Checks }>("GET", v(id, n)),
  saveVersion: (id: number, pkg: PackageDraft) => call<{ created: boolean; version: VersionInfo; checks: Checks }>("POST", `/releases/${id}/versions`, { package: pkg }),
  diff: (id: number, from: number, to: number) => call<{ diff: PackageDiff }>("GET", `/releases/${id}/diff?from=${from}&to=${to}`).then((r) => r.diff),
  getReview: (id: number, n: number) => call<Review>("GET", `${v(id, n)}/review`).catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
  generate: (id: number, n: number, regenerate = false) => call<Review>("POST", `${v(id, n)}/generate`, { regenerate }),
  patchStatement: (id: number, n: number, sid: number, patch: { text?: string; status?: "draft" | "approved" | "rejected" }) => call<{ statement: Statement }>("PATCH", `${v(id, n)}/statements/${sid}`, patch).then((r) => r.statement),
  addStatement: (id: number, n: number, s: { audience: Audience; section: string; text: string; citations: string[] }) => call<{ statement: Statement }>("POST", `${v(id, n)}/statements`, s).then((r) => r.statement),
  carryOver: (id: number, n: number) => call<{ summary: CarrySummary; review: Review }>("POST", `${v(id, n)}/carry-over`, {}),
  makeBrief: (id: number, n: number, audience: Audience) => call<{ brief: Brief }>("POST", `${v(id, n)}/brief`, { audience }).then((r) => r.brief),
  listBriefs: (id: number, n: number) => call<{ briefs: Brief[] }>("GET", `${v(id, n)}/briefs`).then((r) => r.briefs),
};
