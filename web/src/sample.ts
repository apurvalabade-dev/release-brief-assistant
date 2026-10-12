import type { PackageDraft } from "./types";

/** A realistic package with deliberate gaps, so reviewers can see warnings, risks and stale handling. */
export const samplePackage = (): PackageDraft => ({
  completedFeatures: [
    { id: "F-1", title: "CSV export for invoices", description: "Admins can export up to 10,000 invoices as CSV from the billing page." },
    { id: "F-2", title: "Dark mode", description: "Adds a theme switch in user settings." },
  ],
  bugFixes: [{ id: "B-1", title: "Fix login redirect loop", description: "Users with expired sessions no longer loop between /login and /app." }],
  changedBehaviour: [{ id: "C-1", title: "Session timeout reduced to 30 minutes", description: "Was 8 hours." }],
  qaSummary: [
    { id: "Q-1", summary: "Exported 10k-row file in Chrome, Firefox and Safari", result: "pass", covers: ["F-1"] },
    { id: "Q-2", summary: "Login regression suite (42 cases)", result: "pass", covers: ["B-1"] },
    { id: "Q-3", summary: "Session expiry checked manually on staging", result: "partial", covers: ["C-1"] },
  ],
  knownLimitations: [{ id: "L-1", description: "CSV export is capped at 10,000 rows." }],
  migrationNotes: [{ id: "M-1", description: "Set SESSION_TIMEOUT_MINUTES if you rely on the old 8-hour default." }],
  affectedUserGroups: ["Admins", "All end users"],
  noKnownLimitationsConfirmed: false,
  noMigrationRequiredConfirmed: false,
});
