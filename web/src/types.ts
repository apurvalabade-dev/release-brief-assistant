export type QaResult = "pass" | "fail" | "partial" | "not_run";
export interface ChangeItem { id: string; title: string; description: string }
export interface NoteItem { id: string; description: string }
export interface QaItem { id: string; summary: string; result: QaResult; covers: string[] }

export interface PackageDraft {
  completedFeatures: ChangeItem[];
  bugFixes: ChangeItem[];
  changedBehaviour: ChangeItem[];
  qaSummary: QaItem[];
  knownLimitations: NoteItem[];
  migrationNotes: NoteItem[];
  affectedUserGroups: string[];
  noKnownLimitationsConfirmed: boolean;
  noMigrationRequiredConfirmed: boolean;
}

export interface Finding { code: string; severity: "error" | "warning"; section: string; itemId?: string; message: string }
export interface Checks { findings: Finding[]; ready: boolean }

export interface ReleaseSummary { id: number; name: string; createdAt: string; latestVersion: number }
export interface ReleaseDetail { id: number; name: string; createdAt: string; versions: { versionNo: number; packageHash: string; createdAt: string }[] }
export interface VersionInfo { releaseId: number; versionNo: number; package: PackageDraft; packageHash: string; createdAt: string }

export type Audience = "internal" | "stakeholder";
export type Section = "change" | "risk" | "limitation" | "migration";
export type Freshness = "fresh" | "stale" | "source_removed";
export type StatementStatus = "draft" | "approved" | "rejected";

export interface Statement {
  id: number; audience: Audience; section: Section; position: number; text: string;
  citations: string[]; sourceHash: string; status: StatementStatus; editedByHuman: boolean; freshness: Freshness;
}
export interface Analysis {
  model: string | null; createdAt: string;
  classifications: { itemId: string; impact: "breaking" | "user_visible" | "internal"; rationale: string }[];
  gaps: { message: string; relatedItemIds: string[] }[];
  unsupportedClaims: { itemId: string; reason: string; evidenceIds: string[]; source: "deterministic" | "model" }[];
}
export interface Review { analysis: Analysis | null; checks: Checks; statements: Statement[] }
export interface CarrySummary { fromVersion: number; carried: number; fresh: number; stale: number; sourceRemoved: number }

export interface FieldChange { field: string; from: unknown; to: unknown }
export interface PackageDiff {
  sections: { section: string; added: { id: string }[]; removed: { id: string }[]; changed: { id: string; label: string; changes: FieldChange[] }[] }[];
  userGroups: { added: string[]; removed: string[] };
  flags: FieldChange[];
  hasChanges: boolean;
  summary: { added: number; removed: number; changed: number };
}
export interface Brief { id: number; audience: Audience; content: string; createdAt: string }

export const emptyPackage = (): PackageDraft => ({
  completedFeatures: [], bugFixes: [], changedBehaviour: [], qaSummary: [], knownLimitations: [], migrationNotes: [],
  affectedUserGroups: [], noKnownLimitationsConfirmed: false, noMigrationRequiredConfirmed: false,
});
