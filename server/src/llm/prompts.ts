import type { CheckFinding } from "../checks.js";
import type { PackageItem } from "../items.js";
import type { NormalizedPackage } from "../schema.js";
import type { Audience } from "./types.js";

const RULES = `Rules:
- Respond with a single JSON object and nothing else (no markdown fences, no commentary).
- Only cite item ids that appear in the provided items list. Never invent ids.
- Never say a change is tested, verified, stable or safe unless a cited QA item has result "pass" and covers it.
- You cannot approve, publish or deploy a release, and must never say that a release is approved.`;

function context(pkg: NormalizedPackage, items: PackageItem[], findings: CheckFinding[]): string {
  return JSON.stringify({ affectedUserGroups: pkg.affectedUserGroups, items: items.map((i) => ({ id: i.id, kind: i.kind, data: i.data })), deterministicFindings: findings }, null, 2);
}

const feedbackBlock = (feedback?: string[]) =>
  feedback?.length ? `\n\nYour previous answer was rejected for these reasons. Fix all of them:\n${feedback.map((f) => `- ${f}`).join("\n")}` : "";

export function buildAnalyzePrompt(pkg: NormalizedPackage, items: PackageItem[], findings: CheckFinding[], feedback?: string[]) {
  const system = `You review software release packages for a release manager.
${RULES}
Output shape: {"classifications":[{"itemId":string,"impact":"breaking"|"user_visible"|"internal","rationale":string}],"gaps":[{"message":string,"relatedItemIds":string[]}],"unsupportedClaims":[{"itemId":string,"reason":string,"evidenceIds":string[]}]}`;
  const user = `Classify EVERY feature, bug fix and behaviour change (exactly once) by user impact. "breaking" = users or admins must act or may be disrupted. List information that is missing or too vague to write an accurate release note (gaps). List items whose wording claims more than the QA evidence supports (unsupportedClaims).

${context(pkg, items, findings)}${feedbackBlock(feedback)}`;
  return { system, user };
}

export function buildSummarizePrompt(audience: Audience, pkg: NormalizedPackage, items: PackageItem[], findings: CheckFinding[], analysisJson: unknown, feedback?: string[]) {
  const tone =
    audience === "internal"
      ? "Audience: internal technical users (engineers, support, QA). Be precise; mention item ids, QA results and configuration steps."
      : "Audience: non-technical stakeholders and clients. Plain language, no jargon, no item ids in the text. Say plainly what changes for them and what is not yet confirmed.";
  const system = `You write release summaries as short, separate statements.
${RULES}
${tone}
Output shape: {"statements":[{"section":"change"|"risk"|"limitation"|"migration","text":string,"citations":string[]}]}
Every statement MUST cite at least one item id supporting it. Include: one "change" statement per release item; a "risk" statement for every item with a deterministic finding or unsupported claim; a "limitation" statement citing each known limitation; a "migration" statement for each migration note.`;
  const user = `${context(pkg, items, findings)}\n\nAnalysis:\n${JSON.stringify(analysisJson, null, 2)}${feedbackBlock(feedback)}`;
  return { system, user };
}
