import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { itemIndex } from "../items";
import type { Audience, Checks, PackageDraft, Review, Statement } from "../types";
import { AddStatement } from "./AddStatement";
import { Badge, ErrorBox, Findings, when, type Tone } from "./ui";

const statusTone: Record<Statement["status"], Tone> = { draft: "muted", approved: "ok", rejected: "bad" };
const CHANGE_KINDS = new Set(["feature", "bug fix", "behaviour change"]);
const AUDIENCE_LABEL: Record<Audience, string> = { internal: "Internal (technical)", stakeholder: "Stakeholders / clients" };

interface Props {
  releaseId: number;
  versionNo: number;
  pkg: PackageDraft;
  checks: Checks;
}

export function ReviewPanel({ releaseId, versionNo, pkg, checks }: Props) {
  const [review, setReview] = useState<Review | null | undefined>(undefined); // undefined = loading
  const [audience, setAudience] = useState<Audience>("internal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const index = useMemo(() => itemIndex(pkg), [pkg]);

  useEffect(() => {
    let off = false;
    setReview(undefined);
    setError(null);
    setNotice("");
    api
      .getReview(releaseId, versionNo)
      .then((r) => !off && setReview(r))
      .catch((e) => {
        if (off) return;
        setError(e);
        setReview(null);
      });
    return () => {
      off = true;
    };
  }, [releaseId, versionNo]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const generate = (regenerate: boolean) => run(async () => setReview(await api.generate(releaseId, versionNo, regenerate)));
  const carryOver = () =>
    run(async () => {
      const r = await api.carryOver(releaseId, versionNo);
      setReview(r.review);
      const s = r.summary;
      setNotice(`Carried over from v${s.fromVersion}: ${s.fresh} still valid, ${s.stale} stale (back to draft), ${s.sourceRemoved} dropped because their source was removed.`);
    });
  const replace = (s: Statement) => setReview((r) => (r ? { ...r, statements: r.statements.map((x) => (x.id === s.id ? s : x)) } : r));

  if (review === undefined) return <p className="muted">Loading review…</p>;

  const statements = review?.statements.filter((s) => s.audience === audience) ?? [];
  const count = (st: Statement["status"]) => statements.filter((s) => s.status === st).length;
  const staleCount = statements.filter((s) => s.freshness !== "fresh").length;
  const covered = new Set(statements.filter((s) => s.status !== "rejected").flatMap((s) => s.citations));
  const uncovered = [...index.values()].filter((i) => CHANGE_KINDS.has(i.kind) && !covered.has(i.id));

  return (
    <div>
      <ErrorBox error={error} />
      {notice && <p role="status" className="notice">{notice}</p>}

      {review === null ? (
        <div className="card">
          <h3>No review yet for version {versionNo}</h3>
          {!checks.ready && <Findings checks={checks} />}
          <p className="muted">
            {checks.ready
              ? "The AI drafts summaries and flags risks. It cannot approve anything: you review every statement."
              : "Fix the blocking findings in the Package tab and save a new version before generating."}
          </p>
          <div className="row">
            <button onClick={() => generate(false)} disabled={busy || !checks.ready}>
              {busy ? "Generating…" : "Generate summaries"}
            </button>
            {versionNo > 1 && (
              <button className="ghost" onClick={carryOver} disabled={busy}>
                Carry over statements from v{versionNo - 1}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <Findings checks={checks} />
          {review.analysis && <AnalysisCard analysis={review.analysis} />}

          <div className="tabs sub" role="tablist" aria-label="Audience">
            {(["internal", "stakeholder"] as Audience[]).map((a) => (
              <button key={a} role="tab" aria-selected={audience === a} className={audience === a ? "active" : ""} onClick={() => setAudience(a)}>
                {AUDIENCE_LABEL[a]}
              </button>
            ))}
          </div>
          <p className="muted" aria-live="polite">
            {count("approved")} approved · {count("draft")} draft · {count("rejected")} rejected
            {staleCount > 0 && <> · <Badge tone="warn">{staleCount} stale</Badge></>}
          </p>

          <ul className="statements">
            {statements.map((s) => (
              <StatementCard key={s.id} s={s} index={index} releaseId={releaseId} versionNo={versionNo} onChange={replace} />
            ))}
          </ul>

          <AddStatement
            releaseId={releaseId}
            versionNo={versionNo}
            audience={audience}
            items={[...index.values()]}
            uncovered={uncovered}
            onAdded={(st) => setReview((r) => (r ? { ...r, statements: [...r.statements, st] } : r))}
          />

          <button className="ghost" onClick={() => generate(true)} disabled={busy}>
            Regenerate drafts
          </button>
          <span className="muted"> Refused if you have already approved, rejected or edited anything.</span>
        </>
      )}
    </div>
  );
}

function AnalysisCard({ analysis }: { analysis: NonNullable<Review["analysis"]> }) {
  const impactTone = { breaking: "bad", user_visible: "info", internal: "muted" } as const;
  return (
    <section className="card" aria-label="AI analysis">
      <h3>
        Analysis <span className="muted">· {analysis.model ?? "unknown model"} · {when(analysis.createdAt)}</span>
      </h3>
      <h4>Impact</h4>
      <ul className="findings">
        {analysis.classifications.map((c) => (
          <li key={c.itemId}>
            <strong>{c.itemId}</strong> <Badge tone={impactTone[c.impact]}>{c.impact.replace("_", " ")}</Badge> {c.rationale}
          </li>
        ))}
      </ul>
      <h4>Missing or vague information</h4>
      {analysis.gaps.length === 0 ? <p className="muted">None found.</p> : <ul>{analysis.gaps.map((g, i) => <li key={i}>{g.message}</li>)}</ul>}
      <h4>Claims not supported by QA evidence</h4>
      {analysis.unsupportedClaims.length === 0 ? (
        <p className="muted">None found.</p>
      ) : (
        <ul>
          {analysis.unsupportedClaims.map((u, i) => (
            <li key={i}>
              <strong>{u.itemId}</strong> <Badge tone={u.source === "deterministic" ? "warn" : "info"}>{u.source === "deterministic" ? "found by checks" : "found by AI"}</Badge> {u.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatementCard({ s, index, releaseId, versionNo, onChange }: { s: Statement; index: Map<string, { kind: string; label: string }>; releaseId: number; versionNo: number; onChange: (s: Statement) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stale = s.freshness !== "fresh";

  async function patch(p: { text?: string; status?: Statement["status"] }) {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.patchStatement(releaseId, versionNo, s.id, p));
      setEditing(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`statement ${s.status} ${stale ? "stale" : ""}`}>
      <div className="meta">
        <Badge tone="info">{s.section}</Badge>
        <Badge tone={statusTone[s.status]}>{s.status}</Badge>
        {s.freshness === "stale" && <Badge tone="warn" title="Something this statement relies on changed after it was written">stale</Badge>}
        {s.freshness === "source_removed" && <Badge tone="bad" title="An item this statement cites no longer exists">source removed</Badge>}
        {s.editedByHuman && <Badge tone="muted">edited</Badge>}
      </div>

      {editing ? (
        <textarea aria-label="Statement text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p>{s.text}</p>
      )}

      <div className="chips" aria-label="Sources">
        {s.citations.map((c) => {
          const ref = index.get(c);
          return (
            <span key={c} className={`chip src ${ref ? "" : "missing"}`} title={ref ? `${ref.kind}: ${ref.label}` : "This item no longer exists"}>
              {c}
            </span>
          );
        })}
      </div>

      {stale && !editing && <p className="hint">Its sources changed. Edit it to confirm it still holds (this re-checks it against the current package), or reject it.</p>}
      <ErrorBox error={error} />

      <div className="row">
        {editing ? (
          <>
            <button onClick={() => patch({ text })} disabled={busy || !text.trim() || text === s.text}>
              Save text
            </button>
            <button className="ghost" onClick={() => { setEditing(false); setText(s.text); }}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button onClick={() => patch({ status: "approved" })} disabled={busy || s.status === "approved" || stale} title={stale ? "Edit or reject stale statements first" : undefined}>
              Approve
            </button>
            <button className="ghost" onClick={() => patch({ status: "rejected" })} disabled={busy || s.status === "rejected"}>
              Reject
            </button>
            {s.status !== "draft" && (
              <button className="ghost" onClick={() => patch({ status: "draft" })} disabled={busy}>
                Back to draft
              </button>
            )}
            <button className="ghost" onClick={() => { setText(s.text); setEditing(true); }} disabled={busy}>
              Edit
            </button>
          </>
        )}
      </div>
    </li>
  );
}
