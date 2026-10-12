import type { ReactNode } from "react";
import { ApiError } from "../api";
import type { Checks } from "../types";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export const Badge = ({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) => (
  <span className={`badge ${tone}`} title={title}>
    {children}
  </span>
);

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError ? error.details : [];
  return (
    <div role="alert" className="error">
      <strong>{message}</strong>
      {details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Deterministic readiness findings from the server (no AI involved). */
export function Findings({ checks }: { checks: Checks }) {
  return (
    <section aria-label="Readiness checks" className="card">
      <h3>
        Readiness checks {checks.ready ? <Badge tone="ok">ready</Badge> : <Badge tone="bad">blocked</Badge>}
      </h3>
      {checks.findings.length === 0 ? (
        <p className="muted">No findings. Every required section is present and every item has passing QA evidence.</p>
      ) : (
        <ul className="findings">
          {checks.findings.map((f, i) => (
            <li key={i}>
              <Badge tone={f.severity === "error" ? "bad" : "warn"}>{f.severity === "error" ? "must fix" : "review"}</Badge> {f.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const when = (iso: string) => new Date(iso).toLocaleString();
