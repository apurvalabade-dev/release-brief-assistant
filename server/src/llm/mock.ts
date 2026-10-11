import type { CheckFinding } from "../checks.js";
import type { PackageItem } from "../items.js";
import type { NormalizedPackage } from "../schema.js";
import type { AnalysisOutput, Audience, LlmProvider, LlmRequest, StatementsOutput } from "./types.js";

interface MockInput {
  package: NormalizedPackage;
  items: PackageItem[];
  findings: CheckFinding[];
  audience?: Audience;
}

/** Deterministic stand-in for an LLM: same input, same output. Used by tests and keyless demos. */
export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async completeJson(req: LlmRequest): Promise<unknown> {
    const input = req.input as MockInput;
    return req.task === "analyze" ? analyze(input) : summarize(input);
  }
}

const flagged = (findings: CheckFinding[]) => findings.filter((f) => f.itemId && (f.code === "ITEM_WITHOUT_QA" || f.code === "ITEM_QA_NOT_PASSING"));
const coveringQa = (pkg: NormalizedPackage, id: string) => pkg.qaSummary.filter((q) => q.covers.includes(id));

function analyze({ package: pkg, findings }: MockInput): AnalysisOutput {
  const classifications: AnalysisOutput["classifications"] = [
    ...pkg.completedFeatures.map((i) => ({ itemId: i.id, impact: "user_visible" as const, rationale: "New capability visible to users." })),
    ...pkg.bugFixes.map((i) => ({ itemId: i.id, impact: "user_visible" as const, rationale: "Fixes behaviour users could observe." })),
    ...pkg.changedBehaviour.map((i) => ({
      itemId: i.id,
      impact: pkg.migrationNotes.length > 0 ? ("breaking" as const) : ("user_visible" as const),
      rationale: pkg.migrationNotes.length > 0 ? "Behaviour change with required configuration steps." : "Behaviour change without required action.",
    })),
  ];
  const gaps = [...pkg.completedFeatures, ...pkg.bugFixes, ...pkg.changedBehaviour]
    .filter((i) => !i.description)
    .map((i) => ({ message: `${i.id} "${i.title}" has no description.`, relatedItemIds: [i.id] }));
  const unsupportedClaims = flagged(findings).map((f) => ({ itemId: f.itemId!, reason: f.message, evidenceIds: coveringQa(pkg, f.itemId!).map((q) => q.id) }));
  return { classifications, gaps, unsupportedClaims };
}

function summarize({ package: pkg, findings, audience }: MockInput): StatementsOutput {
  const internal = audience === "internal";
  const statements: StatementsOutput["statements"] = [];
  const label = (kind: "feature" | "bugfix" | "behaviour") => (kind === "feature" ? "New" : kind === "bugfix" ? "Fixed" : "Changed");

  const changes = [
    ...pkg.completedFeatures.map((i) => ({ ...i, kind: "feature" as const })),
    ...pkg.bugFixes.map((i) => ({ ...i, kind: "bugfix" as const })),
    ...pkg.changedBehaviour.map((i) => ({ ...i, kind: "behaviour" as const })),
  ];
  for (const c of changes) {
    const qa = coveringQa(pkg, c.id);
    statements.push(
      internal
        ? {
            section: "change",
            text: `${c.id} ${c.title}${c.description ? `: ${c.description}` : ""}. QA: ${qa.length ? qa.map((q) => `${q.id}=${q.result}`).join(", ") : "none"}.`,
            citations: [c.id, ...qa.map((q) => q.id)],
          }
        : { section: "change", text: `${label(c.kind)}: ${c.title}.`, citations: [c.id] },
    );
  }
  for (const f of flagged(findings)) {
    const item = changes.find((c) => c.id === f.itemId);
    statements.push({
      section: "risk",
      text: internal ? `Risk: ${f.message}` : `We are still confirming "${item?.title ?? f.itemId}"; please treat it as not yet verified.`,
      citations: [f.itemId!, ...coveringQa(pkg, f.itemId!).map((q) => q.id)],
    });
  }
  for (const l of pkg.knownLimitations) {
    statements.push({ section: "limitation", text: `Known limitation: ${l.description}`, citations: [l.id] });
  }
  for (const m of pkg.migrationNotes) {
    statements.push({ section: "migration", text: internal ? `Action required: ${m.description}` : `Your administrator needs to: ${m.description}`, citations: [m.id] });
  }
  return { statements };
}
