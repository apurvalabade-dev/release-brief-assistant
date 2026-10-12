import { useEffect, useState } from "react";
import { api } from "../api";
import type { ItemRef } from "../items";
import type { Audience, Section, Statement } from "../types";
import { ErrorBox } from "./ui";

const SECTIONS: Section[] = ["change", "risk", "limitation", "migration"];

interface Props {
  releaseId: number;
  versionNo: number;
  audience: Audience;
  /** Everything a statement may cite. */
  items: ItemRef[];
  /** Release items that no statement covers yet for the current audience. */
  uncovered: ItemRef[];
  onAdded: (s: Statement) => void;
}

/**
 * Lets a human write a statement by hand. This is how new or uncovered items (for example a
 * feature added in a later version) get a statement, since carry-over only copies existing ones.
 */
export function AddStatement({ releaseId, versionNo, audience, items, uncovered, onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const [aud, setAud] = useState<Audience>(audience);
  const [section, setSection] = useState<Section>("change");
  const [text, setText] = useState("");
  const [cited, setCited] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) setAud(audience);
  }, [audience, open]);

  function openFor(id?: string) {
    setOpen(true);
    setAud(audience);
    setSection("change");
    setText("");
    setCited(id ? [id] : []);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.addStatement(releaseId, versionNo, { audience: aud, section, text: text.trim(), citations: cited }));
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Add a statement">
      {uncovered.length > 0 && (
        <div>
          <h3>Not covered yet ({audience === "internal" ? "internal" : "stakeholders"})</h3>
          <p className="muted">These items have no statement for this audience, so the final brief will be refused until each has an approved one.</p>
          <ul className="findings">
            {uncovered.map((i) => (
              <li key={i.id}>
                <strong>{i.id}</strong> {i.label}{" "}
                <button type="button" className="ghost" aria-label={`Write statement for ${i.id}`} onClick={() => openFor(i.id)}>
                  Write statement
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!open ? (
        <button type="button" className="ghost" onClick={() => openFor()}>
          Add a statement
        </button>
      ) : (
        <form onSubmit={submit}>
          <h3>New statement</h3>
          <div className="row">
            <label>
              Audience
              <select value={aud} onChange={(e) => setAud(e.target.value as Audience)}>
                <option value="internal">Internal (technical)</option>
                <option value="stakeholder">Stakeholders / clients</option>
              </select>
            </label>
            <label>
              Section
              <select value={section} onChange={(e) => setSection(e.target.value as Section)}>
                {SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Text
            <textarea aria-label="New statement text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <fieldset className="covers">
            <legend>Sources (what supports this statement)</legend>
            {items.map((i) => (
              <label key={i.id} className="inline" title={`${i.kind}: ${i.label}`}>
                <input type="checkbox" aria-label={`Cite ${i.id}`} checked={cited.includes(i.id)} onChange={(e) => setCited(e.target.checked ? [...cited, i.id] : cited.filter((c) => c !== i.id))} />
                {i.id}
              </label>
            ))}
          </fieldset>
          <ErrorBox error={error} />
          <div className="row">
            <button type="submit" disabled={busy || !text.trim() || cited.length === 0}>
              {busy ? "Adding…" : "Add statement"}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
