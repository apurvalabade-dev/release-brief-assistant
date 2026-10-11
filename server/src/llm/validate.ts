import type { PackageItem } from "../items.js";
import type { AnalysisOutput, StatementsOutput } from "./types.js";

const CHANGE_KINDS = new Set(["feature", "bugfix", "behaviour"]);

/** Returns human-readable problems (empty array = valid). These are fed back to the model on retry. */
export function validateAnalysis(a: AnalysisOutput, items: PackageItem[]): string[] {
  const errors: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const changeIds = items.filter((i) => CHANGE_KINDS.has(i.kind)).map((i) => i.id);

  const seen = new Set<string>();
  for (const c of a.classifications) {
    const item = byId.get(c.itemId);
    if (!item || !CHANGE_KINDS.has(item.kind)) errors.push(`classification refers to unknown or non-change item "${c.itemId}"`);
    if (seen.has(c.itemId)) errors.push(`item "${c.itemId}" is classified more than once`);
    seen.add(c.itemId);
  }
  for (const id of changeIds) if (!seen.has(id)) errors.push(`change item "${id}" has no classification`);

  for (const g of a.gaps) for (const id of g.relatedItemIds) if (!byId.has(id)) errors.push(`gap refers to unknown item "${id}"`);
  for (const u of a.unsupportedClaims) {
    if (!byId.has(u.itemId)) errors.push(`unsupported claim refers to unknown item "${u.itemId}"`);
    for (const e of u.evidenceIds) if (byId.get(e)?.kind !== "qa") errors.push(`unsupported claim cites "${e}", which is not a QA evidence item`);
  }
  return errors;
}

export interface StatementRules {
  /** Change items the deterministic checks flagged (no QA / QA not passing). */
  flaggedItemIds: string[];
}

/**
 * Deterministic guarantees on generated statements, independent of which model wrote them:
 *  1. every citation resolves to a real item (uncited statements are already rejected by the schema)
 *  2. a "limitation" statement cites a limitation item
 *  3. every known limitation is cited somewhere
 *  4. every flagged item is cited by at least one "risk" statement
 */
export function validateStatements(out: StatementsOutput, items: PackageItem[], rules: StatementRules): string[] {
  const errors: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));

  out.statements.forEach((s, n) => {
    for (const id of s.citations) if (!byId.has(id)) errors.push(`statement ${n + 1} cites unknown item "${id}"`);
    if (s.section === "limitation" && !s.citations.some((id) => byId.get(id)?.kind === "limitation")) {
      errors.push(`statement ${n + 1} is a limitation but does not cite a limitation item`);
    }
  });

  const cited = new Set(out.statements.flatMap((s) => s.citations));
  for (const l of items.filter((i) => i.kind === "limitation")) {
    if (!cited.has(l.id)) errors.push(`known limitation "${l.id}" is not mentioned in any statement`);
  }
  const riskCited = new Set(out.statements.filter((s) => s.section === "risk").flatMap((s) => s.citations));
  for (const id of rules.flaggedItemIds) {
    if (!riskCited.has(id)) errors.push(`item "${id}" lacks supporting QA evidence but no "risk" statement cites it`);
  }
  return errors;
}
