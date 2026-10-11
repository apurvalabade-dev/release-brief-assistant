import type { NormalizedPackage } from "./schema.js";

export type CheckSeverity = "error" | "warning";

export interface CheckFinding {
  code:
    | "NO_CHANGES"
    | "NO_QA_EVIDENCE"
    | "NO_AFFECTED_USER_GROUPS"
    | "LIMITATIONS_MISSING"
    | "MIGRATION_NOTES_MISSING"
    | "DUPLICATE_ID"
    | "QA_UNKNOWN_REFERENCE"
    | "ITEM_WITHOUT_QA"
    | "ITEM_QA_NOT_PASSING";
  severity: CheckSeverity;
  section: string;
  itemId?: string;
  message: string;
}

export interface CheckResult {
  findings: CheckFinding[];
  /** True when there are no "error" findings. Warnings never block. */
  ready: boolean;
}

/**
 * Deterministic readiness checks. No LLM: same input, same output.
 * error   = required information missing, or the package contradicts itself.
 * warning = a claim a reviewer should look at (e.g. no passing QA behind it).
 */
export function runDeterministicChecks(pkg: NormalizedPackage): CheckResult {
  const findings: CheckFinding[] = [];
  const add = (f: CheckFinding) => findings.push(f);

  const changeItems = [
    ...pkg.completedFeatures.map((i) => ({ ...i, section: "completedFeatures" })),
    ...pkg.bugFixes.map((i) => ({ ...i, section: "bugFixes" })),
    ...pkg.changedBehaviour.map((i) => ({ ...i, section: "changedBehaviour" })),
  ];

  if (changeItems.length === 0) {
    add({ code: "NO_CHANGES", severity: "error", section: "completedFeatures", message: "Release has no features, bug fixes, or behaviour changes." });
  }
  if (pkg.qaSummary.length === 0) {
    add({ code: "NO_QA_EVIDENCE", severity: "error", section: "qaSummary", message: "QA summary is empty. Without evidence, no claim can be supported." });
  }
  if (pkg.affectedUserGroups.length === 0) {
    add({ code: "NO_AFFECTED_USER_GROUPS", severity: "error", section: "affectedUserGroups", message: "No affected user groups listed." });
  }
  if (pkg.knownLimitations.length === 0 && !pkg.noKnownLimitationsConfirmed) {
    add({ code: "LIMITATIONS_MISSING", severity: "error", section: "knownLimitations", message: "Known limitations are empty. Add them or explicitly confirm there are none." });
  }
  if (pkg.changedBehaviour.length > 0 && pkg.migrationNotes.length === 0 && !pkg.noMigrationRequiredConfirmed) {
    add({ code: "MIGRATION_NOTES_MISSING", severity: "error", section: "migrationNotes", message: "Behaviour changed but there are no migration/configuration notes. Add them or confirm none are needed." });
  }

  // Id integrity
  const allIds = [
    ...changeItems.map((i) => i.id),
    ...pkg.qaSummary.map((i) => i.id),
    ...pkg.knownLimitations.map((i) => i.id),
    ...pkg.migrationNotes.map((i) => i.id),
  ];
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  for (const id of dupes) {
    add({ code: "DUPLICATE_ID", severity: "error", section: "package", itemId: id, message: `Id ${id} is used more than once.` });
  }

  const changeIds = new Set(changeItems.map((i) => i.id));
  for (const q of pkg.qaSummary) {
    for (const ref of q.covers) {
      if (!changeIds.has(ref)) {
        add({ code: "QA_UNKNOWN_REFERENCE", severity: "error", section: "qaSummary", itemId: q.id, message: `QA evidence ${q.id} covers ${ref}, which is not a release item.` });
      }
    }
  }

  // Claim vs evidence (the deterministic half; the LLM handles wording-level claims later)
  for (const item of changeItems) {
    const evidence = pkg.qaSummary.filter((q) => q.covers.includes(item.id));
    if (evidence.length === 0) {
      add({ code: "ITEM_WITHOUT_QA", severity: "warning", section: item.section, itemId: item.id, message: `${item.id} "${item.title}" has no QA evidence covering it.` });
    } else if (!evidence.some((q) => q.result === "pass")) {
      add({
        code: "ITEM_QA_NOT_PASSING",
        severity: "warning",
        section: item.section,
        itemId: item.id,
        message: `${item.id} "${item.title}" has QA evidence, but none of it passed (${evidence.map((q) => `${q.id}=${q.result}`).join(", ")}).`,
      });
    }
  }

  return { findings, ready: !findings.some((f) => f.severity === "error") };
}
