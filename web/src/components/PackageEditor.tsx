import { useEffect, useState } from "react";
import { nextId } from "../items";
import type { ChangeItem, NoteItem, PackageDraft, QaItem, QaResult } from "../types";
import { ErrorBox } from "./ui";

type ChangeKey = "completedFeatures" | "bugFixes" | "changedBehaviour";
type NoteKey = "knownLimitations" | "migrationNotes";

const CHANGES: { key: ChangeKey; label: string; noun: string; prefix: string }[] = [
  { key: "completedFeatures", label: "Completed features", noun: "feature", prefix: "F" },
  { key: "bugFixes", label: "Bug fixes", noun: "bug fix", prefix: "B" },
  { key: "changedBehaviour", label: "Changed behaviour", noun: "behaviour change", prefix: "C" },
];
const NOTES: { key: NoteKey; label: string; noun: string; prefix: string }[] = [
  { key: "knownLimitations", label: "Known limitations", noun: "limitation", prefix: "L" },
  { key: "migrationNotes", label: "Migration or configuration notes", noun: "migration note", prefix: "M" },
];
const RESULTS: QaResult[] = ["pass", "partial", "fail", "not_run"];

interface Props {
  pkg: PackageDraft;
  onSave: (pkg: PackageDraft) => Promise<{ created: boolean }>;
}

export function PackageEditor({ pkg, onSave }: Props) {
  const [draft, setDraft] = useState<PackageDraft>(pkg);
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setDraft(pkg);
    setNotice("");
    setError(null);
  }, [pkg]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(pkg);
  const changeIds = CHANGES.flatMap((c) => draft[c.key].map((i) => i.id));

  const patch = (p: Partial<PackageDraft>) => setDraft((d) => ({ ...d, ...p }));

  function addChange(key: ChangeKey, prefix: string) {
    patch({ [key]: [...draft[key], { id: nextId(prefix, draft[key].map((i) => i.id)), title: "", description: "" }] });
  }
  function editChange(key: ChangeKey, id: string, p: Partial<ChangeItem>) {
    patch({ [key]: draft[key].map((i) => (i.id === id ? { ...i, ...p } : i)) });
  }
  function removeChange(key: ChangeKey, id: string) {
    // Also drop the id from QA coverage so the package never points at a missing item.
    patch({
      [key]: draft[key].filter((i) => i.id !== id),
      qaSummary: draft.qaSummary.map((q) => ({ ...q, covers: q.covers.filter((c) => c !== id) })),
    });
  }
  function addNote(key: NoteKey, prefix: string) {
    patch({ [key]: [...draft[key], { id: nextId(prefix, draft[key].map((i) => i.id)), description: "" }] });
  }
  function editNote(key: NoteKey, id: string, description: string) {
    patch({ [key]: draft[key].map((i: NoteItem) => (i.id === id ? { ...i, description } : i)) });
  }
  function editQa(id: string, p: Partial<QaItem>) {
    patch({ qaSummary: draft.qaSummary.map((q) => (q.id === id ? { ...q, ...p } : q)) });
  }
  function addGroup() {
    const g = group.trim();
    if (g && !draft.affectedUserGroups.includes(g)) patch({ affectedUserGroups: [...draft.affectedUserGroups, g] });
    setGroup("");
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const r = await onSave(draft);
      setNotice(r.created ? "Saved as a new version." : "No changes: this matches the latest version.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="muted">Saving never edits an existing version: it creates a new one, so earlier versions and their reviews stay intact.</p>

      {CHANGES.map((s) => (
        <fieldset key={s.key} className="card">
          <legend>{s.label}</legend>
          {draft[s.key].map((i) => (
            <div key={i.id} className="item">
              <span className="id">{i.id}</span>
              <div className="grow">
                <input aria-label={`${s.noun} ${i.id} title`} placeholder="Title" value={i.title} onChange={(e) => editChange(s.key, i.id, { title: e.target.value })} />
                <textarea aria-label={`${s.noun} ${i.id} description`} placeholder="Description" rows={2} value={i.description} onChange={(e) => editChange(s.key, i.id, { description: e.target.value })} />
              </div>
              <button type="button" className="ghost" aria-label={`Remove ${i.id}`} onClick={() => removeChange(s.key, i.id)}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="ghost" onClick={() => addChange(s.key, s.prefix)}>
            Add {s.noun}
          </button>
        </fieldset>
      ))}

      <fieldset className="card">
        <legend>QA summary (evidence)</legend>
        {draft.qaSummary.map((q) => (
          <div key={q.id} className="item">
            <span className="id">{q.id}</span>
            <div className="grow">
              <input aria-label={`QA ${q.id} summary`} placeholder="What was tested" value={q.summary} onChange={(e) => editQa(q.id, { summary: e.target.value })} />
              <label className="inline">
                Result
                <select aria-label={`QA ${q.id} result`} value={q.result} onChange={(e) => editQa(q.id, { result: e.target.value as QaResult })}>
                  {RESULTS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <div className="covers" role="group" aria-label={`${q.id} covers`}>
                Covers:
                {changeIds.length === 0 && <span className="muted"> add a feature, fix or change first</span>}
                {changeIds.map((id) => (
                  <label key={id} className="inline">
                    <input type="checkbox" aria-label={`${q.id} covers ${id}`} checked={q.covers.includes(id)} onChange={(e) => editQa(q.id, { covers: e.target.checked ? [...q.covers, id] : q.covers.filter((c) => c !== id) })} />
                    {id}
                  </label>
                ))}
              </div>
            </div>
            <button type="button" className="ghost" aria-label={`Remove ${q.id}`} onClick={() => patch({ qaSummary: draft.qaSummary.filter((x) => x.id !== q.id) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => patch({ qaSummary: [...draft.qaSummary, { id: nextId("Q", draft.qaSummary.map((q) => q.id)), summary: "", result: "pass", covers: [] }] })}>
          Add QA evidence
        </button>
      </fieldset>

      {NOTES.map((s) => (
        <fieldset key={s.key} className="card">
          <legend>{s.label}</legend>
          {draft[s.key].map((i) => (
            <div key={i.id} className="item">
              <span className="id">{i.id}</span>
              <input className="grow" aria-label={`${s.noun} ${i.id}`} value={i.description} onChange={(e) => editNote(s.key, i.id, e.target.value)} />
              <button type="button" className="ghost" aria-label={`Remove ${i.id}`} onClick={() => patch({ [s.key]: draft[s.key].filter((x) => x.id !== i.id) })}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="ghost" onClick={() => addNote(s.key, s.prefix)}>
            Add {s.noun}
          </button>
          <label className="inline confirm">
            <input
              type="checkbox"
              checked={s.key === "knownLimitations" ? draft.noKnownLimitationsConfirmed : draft.noMigrationRequiredConfirmed}
              onChange={(e) => patch(s.key === "knownLimitations" ? { noKnownLimitationsConfirmed: e.target.checked } : { noMigrationRequiredConfirmed: e.target.checked })}
            />
            {s.key === "knownLimitations" ? "I confirm there are no known limitations" : "I confirm no migration or configuration is needed"}
          </label>
        </fieldset>
      ))}

      <fieldset className="card">
        <legend>Affected user groups</legend>
        <div className="chips">
          {draft.affectedUserGroups.map((g) => (
            <span key={g} className="chip">
              {g}
              <button type="button" aria-label={`Remove group ${g}`} onClick={() => patch({ affectedUserGroups: draft.affectedUserGroups.filter((x) => x !== g) })}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <input
            aria-label="New user group"
            placeholder="e.g. Admins"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addGroup();
              }
            }}
          />
          <button type="button" className="ghost" onClick={addGroup}>
            Add group
          </button>
        </div>
      </fieldset>

      <ErrorBox error={error} />
      {notice && <p role="status" className="notice">{notice}</p>}
      <button type="button" onClick={save} disabled={!dirty || busy}>
        {busy ? "Saving…" : "Save as new version"}
      </button>
    </div>
  );
}
