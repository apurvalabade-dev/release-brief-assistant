import type { PackageDraft } from "./types";

export interface ItemRef { id: string; kind: string; label: string }

/** id -> label lookup so citation chips can show what they point at. */
export function itemIndex(pkg: PackageDraft): Map<string, ItemRef> {
  const m = new Map<string, ItemRef>();
  const add = (kind: string, id: string, label: string) => m.set(id, { id, kind, label });
  pkg.completedFeatures.forEach((i) => add("feature", i.id, i.title));
  pkg.bugFixes.forEach((i) => add("bug fix", i.id, i.title));
  pkg.changedBehaviour.forEach((i) => add("behaviour change", i.id, i.title));
  pkg.qaSummary.forEach((i) => add("QA evidence", i.id, `${i.summary} (${i.result})`));
  pkg.knownLimitations.forEach((i) => add("limitation", i.id, i.description));
  pkg.migrationNotes.forEach((i) => add("migration note", i.id, i.description));
  return m;
}

/** Next free "<prefix>-<n>" id; matches the server's numbering so ids stay stable on save. */
export function nextId(prefix: string, existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}
