import { z } from "zod";

const text = z.string().trim().min(1, "must not be empty");
const optionalId = z
  .string()
  .trim()
  .regex(/^[A-Z]-\d+$/, "id must look like F-1")
  .optional();

const changeItem = z.object({ id: optionalId, title: text, description: z.string().trim().default("") });
const noteItem = z.object({ id: optionalId, description: text });

export const releasePackageSchema = z.object({
  completedFeatures: z.array(changeItem).default([]),
  bugFixes: z.array(changeItem).default([]),
  changedBehaviour: z.array(changeItem).default([]),
  qaSummary: z
    .array(
      z.object({
        id: optionalId,
        summary: text,
        result: z.enum(["pass", "fail", "partial", "not_run"]),
        /** Ids of release items (features, bug fixes, behaviour changes) this evidence covers. */
        covers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  knownLimitations: z.array(noteItem).default([]),
  migrationNotes: z.array(noteItem).default([]),
  affectedUserGroups: z.array(text).default([]),
  /** Explicit "nothing to report" confirmations, so empty means "none", not "forgot". */
  noKnownLimitationsConfirmed: z.boolean().default(false),
  noMigrationRequiredConfirmed: z.boolean().default(false),
});

export type ReleasePackageInput = z.input<typeof releasePackageSchema>;
type Parsed = z.output<typeof releasePackageSchema>;
type WithId<T> = Omit<T, "id"> & { id: string };

export type NormalizedPackage = {
  completedFeatures: WithId<Parsed["completedFeatures"][number]>[];
  bugFixes: WithId<Parsed["bugFixes"][number]>[];
  changedBehaviour: WithId<Parsed["changedBehaviour"][number]>[];
  qaSummary: WithId<Parsed["qaSummary"][number]>[];
  knownLimitations: WithId<Parsed["knownLimitations"][number]>[];
  migrationNotes: WithId<Parsed["migrationNotes"][number]>[];
  affectedUserGroups: string[];
  noKnownLimitationsConfirmed: boolean;
  noMigrationRequiredConfirmed: boolean;
};

/**
 * Keeps ids the client already has (so ids and citations stay stable across versions)
 * and gives new items the next free `<prefix>-<n>`.
 */
function assignIds<T extends { id?: string | undefined }>(items: T[], prefix: string): WithId<T>[] {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const item of items) {
    const m = item.id ? pattern.exec(item.id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return items.map((item) => ({ ...item, id: item.id ?? `${prefix}-${++max}` }));
}

/** Throws ZodError on structurally invalid input (the API turns that into a 400). */
export function parsePackage(raw: unknown): NormalizedPackage {
  const p = releasePackageSchema.parse(raw);
  return {
    ...p,
    completedFeatures: assignIds(p.completedFeatures, "F"),
    bugFixes: assignIds(p.bugFixes, "B"),
    changedBehaviour: assignIds(p.changedBehaviour, "C"),
    qaSummary: assignIds(p.qaSummary, "Q"),
    knownLimitations: assignIds(p.knownLimitations, "L"),
    migrationNotes: assignIds(p.migrationNotes, "M"),
  };
}
