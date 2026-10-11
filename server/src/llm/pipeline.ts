import type { CheckResult } from "../checks.js";
import { collectItems, sourceHashFor, type PackageItem } from "../items.js";
import type { NormalizedPackage } from "../schema.js";
import { buildAnalyzePrompt, buildSummarizePrompt } from "./prompts.js";
import { analysisOutputSchema, AUDIENCES, statementsOutputSchema, type AnalysisOutput, type Audience, type LlmProvider, type LlmRequest, type StatementSection } from "./types.js";
import { validateAnalysis, validateStatements } from "./validate.js";

export class GenerationError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface GeneratedStatement {
  audience: Audience;
  section: StatementSection;
  position: number;
  text: string;
  citations: string[];
  sourceHash: string;
}

export interface UnsupportedClaim {
  itemId: string;
  reason: string;
  evidenceIds: string[];
  /** "deterministic" claims come from code and cannot be hidden by the model. */
  source: "deterministic" | "model";
}

export interface GeneratedReview {
  model: string;
  classifications: AnalysisOutput["classifications"];
  gaps: AnalysisOutput["gaps"];
  unsupportedClaims: UnsupportedClaim[];
  statements: GeneratedStatement[];
}

const MAX_ATTEMPTS = 2;

/**
 * Calls the provider, parses and validates the answer. If it is invalid, retries once
 * with the concrete problems appended to the prompt; if still invalid, fails loudly.
 */
async function askValidated<T>(
  provider: LlmProvider,
  task: LlmRequest["task"],
  input: unknown,
  build: (feedback?: string[]) => { system: string; user: string },
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  label: string,
): Promise<T> {
  let feedback: string[] | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: unknown;
    try {
      raw = await provider.completeJson({ task, ...build(feedback), input });
    } catch (err) {
      throw new GenerationError(`LLM provider failed during ${label}`, [(err as Error).message]);
    }
    const result = parse(raw);
    if (result.ok) return result.value;
    feedback = result.errors;
  }
  throw new GenerationError(`${label} failed validation after ${MAX_ATTEMPTS} attempts`, feedback ?? []);
}

export async function generateReview(provider: LlmProvider, pkg: NormalizedPackage, checks: CheckResult): Promise<GeneratedReview> {
  const items: PackageItem[] = collectItems(pkg);
  const base = { package: pkg, items, findings: checks.findings };
  const flaggedFindings = checks.findings.filter((f) => f.itemId && (f.code === "ITEM_WITHOUT_QA" || f.code === "ITEM_QA_NOT_PASSING"));

  const analysis = await askValidated<AnalysisOutput>(
    provider,
    "analyze",
    base,
    (fb) => buildAnalyzePrompt(pkg, items, checks.findings, fb),
    (raw) => {
      const p = analysisOutputSchema.safeParse(raw);
      if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      const errors = validateAnalysis(p.data, items);
      return errors.length ? { ok: false, errors } : { ok: true, value: p.data };
    },
    "analysis",
  );

  // The model may add unsupported claims, but can never remove the ones the checks found.
  const unsupportedClaims: UnsupportedClaim[] = flaggedFindings.map((f) => ({
    itemId: f.itemId!,
    reason: f.message,
    evidenceIds: pkg.qaSummary.filter((q) => q.covers.includes(f.itemId!)).map((q) => q.id),
    source: "deterministic" as const,
  }));
  for (const u of analysis.unsupportedClaims) {
    if (!unsupportedClaims.some((d) => d.itemId === u.itemId)) unsupportedClaims.push({ ...u, source: "model" });
  }

  const statements: GeneratedStatement[] = [];
  for (const audience of AUDIENCES) {
    const out = await askValidated(
      provider,
      "summarize",
      { ...base, audience, analysis },
      (fb) => buildSummarizePrompt(audience, pkg, items, checks.findings, analysis, fb),
      (raw) => {
        const p = statementsOutputSchema.safeParse(raw);
        if (!p.success) return { ok: false as const, errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
        const errors = validateStatements(p.data, items, { flaggedItemIds: [...new Set(flaggedFindings.map((f) => f.itemId!))] });
        return errors.length ? { ok: false as const, errors } : { ok: true as const, value: p.data };
      },
      `${audience} summary`,
    );
    out.statements.forEach((s, position) => {
      const citations = [...new Set(s.citations)];
      statements.push({ audience, section: s.section, position, text: s.text, citations, sourceHash: sourceHashFor(citations, items)! });
    });
  }

  return { model: provider.name, classifications: analysis.classifications, gaps: analysis.gaps, unsupportedClaims, statements };
}
