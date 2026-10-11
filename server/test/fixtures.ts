/** A complete, internally consistent package. Tests tweak copies of this. */
export const goodPackage = () => ({
  completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }],
  bugFixes: [{ title: "Fix login redirect loop" }],
  changedBehaviour: [] as { id?: string; title: string }[],
  qaSummary: [
    { id: "Q-1", summary: "Export verified on 3 browsers", result: "pass" as const, covers: ["F-1"] },
    { id: "Q-2", summary: "Login regression suite", result: "pass" as const, covers: ["B-1"] },
  ],
  knownLimitations: [{ description: "Export capped at 10k rows" }],
  migrationNotes: [] as { description: string }[],
  affectedUserGroups: ["Admins"],
  noMigrationRequiredConfirmed: true,
});
