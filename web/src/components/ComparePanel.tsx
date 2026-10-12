import { useEffect, useState } from "react";
import { api } from "../api";
import type { PackageDiff, Review } from "../types";
import { Badge, ErrorBox } from "./ui";

const show = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
};

export function ComparePanel({ releaseId, versions, selected }: { releaseId: number; versions: number[]; selected: number }) {
  const [to, setTo] = useState(selected);
  const [from, setFrom] = useState(Math.max(1, selected - 1));
  const [diff, setDiff] = useState<PackageDiff | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setTo(selected);
    setFrom(Math.max(1, selected - 1));
  }, [selected]);

  useEffect(() => {
    if (from === to) return;
    let off = false;
    setDiff(null);
    setReview(null);
    setError(null);
    Promise.all([api.diff(releaseId, from, to), api.getReview(releaseId, to)])
      .then(([d, r]) => {
        if (off) return;
        setDiff(d);
        setReview(r);
      })
      .catch((e) => !off && setError(e));
    return () => {
      off = true;
    };
  }, [releaseId, from, to]);

  if (versions.length < 2) return <p className="muted">Save at least two versions to compare them.</p>;
  const stale = review?.statements.filter((s) => s.freshness !== "fresh") ?? [];

  return (
    <div>
      <div className="row card">
        <label>
          From
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {versions.map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
        </label>
        <label>
          To
          <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {versions.map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
        </label>
      </div>
      {from === to && <p className="muted">Pick two different versions.</p>}
      <ErrorBox error={error} />
      {diff && (
        <>
          <section className="card" aria-label="Changes">
            <h3>
              Changes v{from} → v{to}
            </h3>
            {!diff.hasChanges ? (
              <p className="muted">The packages are identical.</p>
            ) : (
              <>
                <p>
                  <Badge tone="ok">{diff.summary.added} added</Badge> <Badge tone="bad">{diff.summary.removed} removed</Badge> <Badge tone="warn">{diff.summary.changed} changed</Badge>
                </p>
                {diff.sections.map((s) => (
                  <div key={s.section}>
                    <h4>{s.section}</h4>
                    <ul>
                      {s.added.map((i) => <li key={`a${i.id}`}><Badge tone="ok">added</Badge> {i.id}</li>)}
                      {s.removed.map((i) => <li key={`r${i.id}`}><Badge tone="bad">removed</Badge> {i.id}</li>)}
                      {s.changed.map((i) => (
                        <li key={`c${i.id}`}>
                          <Badge tone="warn">changed</Badge> <strong>{i.id}</strong> {i.label}
                          <ul>
                            {i.changes.map((c) => (
                              <li key={c.field}>
                                {c.field}: <del>{show(c.from)}</del> → <ins>{show(c.to)}</ins>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {(diff.userGroups.added.length > 0 || diff.userGroups.removed.length > 0) && (
                  <p>User groups: {diff.userGroups.added.map((g) => `+${g}`).concat(diff.userGroups.removed.map((g) => `−${g}`)).join(", ")}</p>
                )}
                {diff.flags.map((f) => <p key={f.field}>{f.field}: {String(f.from)} → {String(f.to)}</p>)}
              </>
            )}
          </section>

          <section className="card" aria-label="Stale statements">
            <h3>Statements affected in v{to}</h3>
            {review === null ? (
              <p className="muted">v{to} has no statements yet. Open the Review tab and carry them over from the previous version to see which ones became stale.</p>
            ) : stale.length === 0 ? (
              <p className="muted">No statements in v{to} are stale.</p>
            ) : (
              <ul>
                {stale.map((s) => (
                  <li key={s.id}>
                    <Badge tone={s.freshness === "stale" ? "warn" : "bad"}>{s.freshness === "stale" ? "stale" : "source removed"}</Badge> <em>{s.audience}</em>: {s.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
