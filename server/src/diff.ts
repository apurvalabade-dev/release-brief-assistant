import { stableStringify } from "./hash.js";
import type { NormalizedPackage } from "./schema.js";

export const SECTIONS = ["completedFeatures", "bugFixes", "changedBehaviour", "qaSummary", "knownLimitations", "migrationNotes"] as const;
export type SectionName = (typeof SECTIONS)[number];

type AnyItem = { id: string } & Record<string, unknown>;

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}
export interface ItemChange {
  id: string;
  label: string;
  changes: FieldChange[];
}
export interface SectionDiff {
  section: SectionName;
  added: AnyItem[];
  removed: AnyItem[];
  changed: ItemChange[];
}
export interface PackageDiff {
  /** Only sections that actually differ. */
  sections: SectionDiff[];
  userGroups: { added: string[]; removed: string[] };
  flags: FieldChange[];
  hasChanges: boolean;
  summary: { added: number; removed: number; changed: number };
}

const labelOf = (i: AnyItem): string => String(i["title"] ?? i["summary"] ?? i["description"] ?? i.id);
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

function diffItems(section: SectionName, a: AnyItem[], b: AnyItem[]): SectionDiff {
  const before = new Map(a.map((i) => [i.id, i]));
  const after = new Map(b.map((i) => [i.id, i]));
  const added = b.filter((i) => !before.has(i.id));
  const removed = a.filter((i) => !after.has(i.id));
  const changed: ItemChange[] = [];
  for (const item of b) {
    const old = before.get(item.id);
    if (!old) continue;
    const fields = [...new Set([...Object.keys(old), ...Object.keys(item)])].filter((k) => k !== "id").sort();
    const changes = fields.filter((f) => !same(old[f], item[f])).map((field) => ({ field, from: old[field], to: item[field] }));
    if (changes.length) changed.push({ id: item.id, label: labelOf(item), changes });
  }
  return { section, added, removed, changed };
}

/** Compares two normalized packages item-by-item, matching on stable item ids. */
export function diffPackages(from: NormalizedPackage, to: NormalizedPackage): PackageDiff {
  const sections = SECTIONS.map((s) => diffItems(s, from[s] as AnyItem[], to[s] as AnyItem[])).filter(
    (d) => d.added.length || d.removed.length || d.changed.length,
  );

  const userGroups = {
    added: to.affectedUserGroups.filter((g) => !from.affectedUserGroups.includes(g)),
    removed: from.affectedUserGroups.filter((g) => !to.affectedUserGroups.includes(g)),
  };

  const flags: FieldChange[] = (["noKnownLimitationsConfirmed", "noMigrationRequiredConfirmed"] as const)
    .filter((f) => from[f] !== to[f])
    .map((field) => ({ field, from: from[field], to: to[field] }));

  const summary = {
    added: sections.reduce((n, s) => n + s.added.length, 0) + userGroups.added.length,
    removed: sections.reduce((n, s) => n + s.removed.length, 0) + userGroups.removed.length,
    changed: sections.reduce((n, s) => n + s.changed.length, 0) + flags.length,
  };
  return { sections, userGroups, flags, hasChanges: summary.added + summary.removed + summary.changed > 0, summary };
}
