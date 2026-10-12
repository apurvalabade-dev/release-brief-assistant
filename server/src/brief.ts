import type { CheckResult } from "./checks.js";
import { freshness, type PackageItem } from "./items.js";
import type { Audience, StatementSection } from "./llm/types.js";
import type { NormalizedPackage } from "./schema.js";

export interface BriefStatement {
  audience: Audience;
  section: StatementSection;
  position: number;
  text: string;
  citations: string[];
  sourceHash: string;
  status: "draft" | "approved" | "rejected";
}

export type BriefResult = { ok: true; content: string } | { ok: false; errors: string[] };

const CHANGE_KINDS = new Set(["feature", "bugfix", "behaviour"]);
const ORDER: StatementSection[] = ["change", "risk", "limitation", "migration"];
const HEADINGS: Record<StatementSection, string> = {
  change: "What is changing",
  risk: "Risks and items not yet verified",
  limitation: "Known limitations",
  migration: "Required actions",
};

/**
 * Builds the final brief from human-APPROVED statements only. Refuses unless the review is
 * complete: nothing left in draft, nothing approved on stale sources, and the approved set
 * still covers every release item, every limitation and every weakly-evidenced item.
 */
export function buildBrief(args: {
  releaseName: string;
  versionNo: number;
  audience: Audience;
  pkg: NormalizedPackage;
  items: PackageItem[];
  checks: CheckResult;
  statements: BriefStatement[];
}): BriefResult {
  const { releaseName, versionNo, audience, pkg, items, checks } = args;
  const mine = args.statements.filter((s) => s.audience === audience);
  const errors: string[] = [];

  if (!checks.ready) errors.push("The release package still has blocking findings.");
  if (mine.length === 0) errors.push(`No ${audience} statements exist for this version.`);

  const drafts = mine.filter((s) => s.status === "draft").length;
  if (drafts > 0) errors.push(`${drafts} statement(s) are still drafts; approve or reject each one.`);

  const approved = mine.filter((s) => s.status === "approved");
  if (approved.length === 0 && mine.length > 0) errors.push("No statements are approved.");
  for (const s of approved) {
    const f = freshness(s.sourceHash, s.citations, items);
    if (f !== "fresh") errors.push(`Approved statement "${s.text.slice(0, 60)}" is ${f === "stale" ? "stale (its sources changed)" : "citing removed items"}.`);
  }

  const cited = new Set(approved.flatMap((s) => s.citations));
  const riskCited = new Set(approved.filter((s) => s.section === "risk").flatMap((s) => s.citations));
  for (const i of items.filter((x) => CHANGE_KINDS.has(x.kind))) if (!cited.has(i.id)) errors.push(`${i.id} "${i.label}" is not covered by any approved statement.`);
  for (const i of items.filter((x) => x.kind === "limitation")) if (!cited.has(i.id)) errors.push(`Known limitation ${i.id} is not covered by any approved statement.`);
  const flagged = new Set(checks.findings.filter((f) => f.itemId && (f.code === "ITEM_WITHOUT_QA" || f.code === "ITEM_QA_NOT_PASSING")).map((f) => f.itemId!));
  for (const id of flagged) if (!riskCited.has(id)) errors.push(`${id} lacks supporting QA evidence and no approved risk statement covers it.`);

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };

  const lines: string[] = [
    `# Release brief: ${releaseName} (v${versionNo}), ${audience === "internal" ? "internal technical" : "stakeholder"} edition`,
    "",
    "> Reviewed by a human. This brief is not a deployment approval; this tool never approves or deploys a release.",
    "",
    `**Affected user groups:** ${pkg.affectedUserGroups.join(", ")}`,
  ];
  for (const section of ORDER) {
    const rows = approved.filter((s) => s.section === section).sort((a, b) => a.position - b.position);
    if (!rows.length) continue;
    lines.push("", `## ${HEADINGS[section]}`, "");
    for (const s of rows) lines.push(`- ${s.text} _(sources: ${s.citations.join(", ")})_`);
  }
  return { ok: true, content: lines.join("\n") + "\n" };
}
