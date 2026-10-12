import { useEffect, useState } from "react";
import { api } from "../api";
import { samplePackage } from "../sample";
import { emptyPackage, type ReleaseSummary } from "../types";
import { ErrorBox, when } from "./ui";

export function ReleaseList({ onOpen }: { onOpen: (id: number) => void }) {
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null);
  const [name, setName] = useState("");
  const [useSample, setUseSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.listReleases().then(setReleases).catch((e) => {
      setError(e);
      setReleases([]);
    });
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRelease(name.trim(), useSample ? samplePackage() : emptyPackage());
      onOpen(r.release.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Releases</h2>
      <ErrorBox error={error} />
      <form onSubmit={create} className="card row">
        <label>
          Release name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Billing 2.4" required />
        </label>
        <label className="inline">
          <input type="checkbox" checked={useSample} onChange={(e) => setUseSample(e.target.checked)} /> Start from a sample package
        </label>
        <button type="submit" disabled={busy || !name.trim()}>
          Create release
        </button>
      </form>
      {releases === null ? (
        <p className="muted">Loading…</p>
      ) : releases.length === 0 ? (
        <p className="muted">No releases yet. Create one above.</p>
      ) : (
        <ul className="list">
          {releases.map((r) => (
            <li key={r.id}>
              <button className="link" onClick={() => onOpen(r.id)}>
                {r.name}
              </button>
              <span className="muted">
                {" "}
                v{r.latestVersion} · created {when(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
