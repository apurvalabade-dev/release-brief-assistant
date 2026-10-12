import { useEffect, useState } from "react";
import { api } from "../api";
import type { Audience, Brief } from "../types";
import { ErrorBox, when } from "./ui";

function download(b: Brief, versionNo: number) {
  const url = URL.createObjectURL(new Blob([b.content], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `release-brief-v${versionNo}-${b.audience}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function BriefPanel({ releaseId, versionNo }: { releaseId: number; versionNo: number }) {
  const [audience, setAudience] = useState<Audience>("stakeholder");
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [current, setCurrent] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let off = false;
    setCurrent(null);
    setError(null);
    api.listBriefs(releaseId, versionNo).then((b) => !off && setBriefs(b)).catch(() => !off && setBriefs([]));
    return () => {
      off = true;
    };
  }, [releaseId, versionNo]);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const b = await api.makeBrief(releaseId, versionNo, audience);
      setCurrent(b);
      setBriefs((prev) => [b, ...prev]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <p>
          The final brief is assembled only from statements you approved, and only when nothing is pending, stale, or missing. It is a summary for communication, <strong>not a deployment approval</strong>.
        </p>
        <div className="row">
          <label>
            Audience
            <select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
              <option value="stakeholder">Stakeholders / clients</option>
              <option value="internal">Internal (technical)</option>
            </select>
          </label>
          <button onClick={make} disabled={busy}>
            {busy ? "Building…" : "Generate final brief"}
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {current && (
        <section className="card" aria-label="Final brief">
          <div className="row">
            <h3>Brief · {current.audience}</h3>
            <button className="ghost" onClick={() => download(current, versionNo)}>
              Download .md
            </button>
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(current.content)}>
              Copy
            </button>
          </div>
          <pre className="brief">{current.content}</pre>
        </section>
      )}
      {briefs.length > 0 && (
        <section className="card" aria-label="Earlier briefs">
          <h3>Earlier briefs for v{versionNo}</h3>
          <ul className="list">
            {briefs.map((b) => (
              <li key={b.id}>
                <button className="link" onClick={() => setCurrent(b)}>
                  {b.audience}
                </button>{" "}
                <span className="muted">{when(b.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
