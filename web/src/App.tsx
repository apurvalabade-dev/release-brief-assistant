import { useEffect, useState } from "react";
import { ReleaseList } from "./components/ReleaseList";
import { ReleaseView } from "./components/ReleaseView";

const fromHash = (): number | null => {
  const m = /^#\/releases\/(\d+)$/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
};

export function App() {
  const [releaseId, setReleaseId] = useState<number | null>(fromHash());

  useEffect(() => {
    const onHash = () => setReleaseId(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = (id: number | null) => {
    window.location.hash = id === null ? "" : `#/releases/${id}`;
    setReleaseId(id);
  };

  return (
    <>
      <header className="top">
        <h1>Release Brief Assistant</h1>
        <p className="muted">Turn a release package into reviewed, evidence-backed briefs. The AI drafts; you decide. Nothing here deploys or approves a release.</p>
      </header>
      <main>{releaseId === null ? <ReleaseList onOpen={open} /> : <ReleaseView releaseId={releaseId} onBack={() => open(null)} />}</main>
    </>
  );
}
