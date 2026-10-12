import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Checks, ReleaseDetail, VersionInfo } from "../types";
import { BriefPanel } from "./BriefPanel";
import { ComparePanel } from "./ComparePanel";
import { PackageEditor } from "./PackageEditor";
import { ReviewPanel } from "./ReviewPanel";
import { ErrorBox, Findings, when } from "./ui";

type Tab = "package" | "review" | "compare" | "brief";
const TABS: { id: Tab; label: string }[] = [
  { id: "package", label: "1. Package" },
  { id: "review", label: "2. Review" },
  { id: "compare", label: "Compare versions" },
  { id: "brief", label: "3. Final brief" },
];

export function ReleaseView({ releaseId, onBack }: { releaseId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const [data, setData] = useState<{ version: VersionInfo; checks: Checks } | null>(null);
  const [tab, setTab] = useState<Tab>("package");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let off = false;
    setDetail(null);
    setVersionNo(null);
    setData(null);
    api
      .getRelease(releaseId)
      .then((d) => {
        if (off) return;
        setDetail(d);
        setVersionNo(d.versions[d.versions.length - 1]?.versionNo ?? 1);
      })
      .catch((e) => !off && setError(e));
    return () => {
      off = true;
    };
  }, [releaseId]);

  useEffect(() => {
    if (versionNo === null) return;
    let off = false;
    api
      .getVersion(releaseId, versionNo)
      .then((d) => !off && setData(d))
      .catch((e) => !off && setError(e));
    return () => {
      off = true;
    };
  }, [releaseId, versionNo]);

  const save = useCallback(
    async (pkg: VersionInfo["package"]) => {
      const r = await api.saveVersion(releaseId, pkg);
      setDetail(await api.getRelease(releaseId));
      if (r.created) setVersionNo(r.version.versionNo);
      else setData({ version: r.version, checks: r.checks });
      return { created: r.created };
    },
    [releaseId],
  );

  if (error && !detail) return (<><button className="link" onClick={onBack}>← All releases</button><ErrorBox error={error} /></>);
  if (!detail || versionNo === null) return <p className="muted">Loading…</p>;
  const numbers = detail.versions.map((v) => v.versionNo);
  const latest = numbers[numbers.length - 1];

  return (
    <div>
      <button className="link" onClick={onBack}>← All releases</button>
      <h2>{detail.name}</h2>
      <div className="row">
        <label>
          Version
          <select aria-label="Version" value={versionNo} onChange={(e) => setVersionNo(Number(e.target.value))}>
            {detail.versions.map((v) => (
              <option key={v.versionNo} value={v.versionNo}>
                v{v.versionNo} · {when(v.createdAt)}
                {v.versionNo === latest ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </label>
        {versionNo !== latest && <span className="muted">Viewing an older version. Saving creates a new latest version.</span>}
      </div>
      <ErrorBox error={error} />

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {!data ? (
        <p className="muted">Loading version…</p>
      ) : (
        <div role="tabpanel">
          {tab === "package" && (
            <>
              <Findings checks={data.checks} />
              <PackageEditor pkg={data.version.package} onSave={save} />
            </>
          )}
          {tab === "review" && <ReviewPanel releaseId={releaseId} versionNo={versionNo} pkg={data.version.package} checks={data.checks} />}
          {tab === "compare" && <ComparePanel releaseId={releaseId} versions={numbers} selected={versionNo} />}
          {tab === "brief" && <BriefPanel releaseId={releaseId} versionNo={versionNo} />}
        </div>
      )}
    </div>
  );
}
