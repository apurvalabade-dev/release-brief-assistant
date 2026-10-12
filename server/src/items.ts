import { hashOf } from "./hash.js";
import type { NormalizedPackage } from "./schema.js";

export type ItemKind = "feature" | "bugfix" | "behaviour" | "qa" | "limitation" | "migration";

/** Anything a generated statement is allowed to cite. */
export interface PackageItem {
  id: string;
  kind: ItemKind;
  label: string;
  hash: string;
  data: unknown;
}

/** Flat list of every citable item, each with a hash of its own content. */
export function collectItems(pkg: NormalizedPackage): PackageItem[] {
  const out: PackageItem[] = [];
  const push = <T extends { id: string }>(kind: ItemKind, items: T[], label: (i: T) => string) => {
    for (const i of items) out.push({ id: i.id, kind, label: label(i), hash: hashOf(i), data: i });
  };
  push("feature", pkg.completedFeatures, (i) => i.title);
  push("bugfix", pkg.bugFixes, (i) => i.title);
  push("behaviour", pkg.changedBehaviour, (i) => i.title);
  push("qa", pkg.qaSummary, (i) => i.summary);
  push("limitation", pkg.knownLimitations, (i) => i.description);
  push("migration", pkg.migrationNotes, (i) => i.description);
  return out;
}

const CHANGE_KINDS = new Set<ItemKind>(["feature", "bugfix", "behaviour"]);

/**
 * Fingerprint of the exact content a statement relies on. Stored with the statement when it
 * is generated; if a later version produces a different fingerprint for the same ids, the
 * statement is stale. Returns null if any cited id no longer exists.
 *
 * For a cited release item (feature / bug fix / behaviour change) the fingerprint also covers
 * the QA evidence attached to it. Otherwise a "not yet verified" statement would stay fresh
 * after passing evidence is added, because the item it cites did not itself change.
 */
export function sourceHashFor(citedIds: string[], items: PackageItem[]): string | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const qaItems = items.filter((i) => i.kind === "qa");
  const parts: string[] = [];
  for (const id of [...new Set(citedIds)].sort()) {
    const item = byId.get(id);
    if (!item) return null;
    parts.push(`${id}:${item.hash}`);
    if (CHANGE_KINDS.has(item.kind)) {
      const evidence = qaItems.filter((q) => ((q.data as { covers?: string[] }).covers ?? []).includes(id)).sort((a, b) => a.id.localeCompare(b.id));
      for (const q of evidence) parts.push(`${id}<-${q.id}:${q.hash}`);
    }
  }
  return hashOf(parts);
}

export type Freshness = "fresh" | "stale" | "source_removed";

export function freshness(storedSourceHash: string, citedIds: string[], currentItems: PackageItem[]): Freshness {
  const current = sourceHashFor(citedIds, currentItems);
  if (current === null) return "source_removed";
  return current === storedSourceHash ? "fresh" : "stale";
}
