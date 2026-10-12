import { describe, expect, it } from "vitest";
import { buildBrief, type BriefStatement } from "../src/brief.js";
import { runDeterministicChecks } from "../src/checks.js";
import { collectItems } from "../src/items.js";
import { MockProvider } from "../src/llm/mock.js";
import { generateReview } from "../src/llm/pipeline.js";
import type { Audience } from "../src/llm/types.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

const risky = () => ({
  ...goodPackage(),
  completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }, { id: "F-2", title: "Dark mode" }],
  changedBehaviour: [{ id: "C-1", title: "Default timeout is now 30s" }],
  migrationNotes: [{ description: "Set EXPORT_LIMIT env var" }],
  noMigrationRequiredConfirmed: false,
});

async function setup(raw: unknown = risky()) {
  const pkg = parsePackage(raw);
  const checks = runDeterministicChecks(pkg);
  const items = collectItems(pkg);
  const review = await generateReview(new MockProvider(), pkg, checks);
  const statements: BriefStatement[] = review.statements.map((s) => ({ ...s, status: "approved" as const }));
  const brief = (audience: Audience, sts = statements, over: Partial<{ checks: typeof checks; items: typeof items }> = {}) =>
    buildBrief({ releaseName: "Acme", versionNo: 3, audience, pkg, items: over.items ?? items, checks: over.checks ?? checks, statements: sts });
  return { pkg, checks, items, statements, brief };
}

describe("buildBrief", () => {
  it("builds a cited brief from fully approved statements", async () => {
    const { brief } = await setup();
    const r = brief("internal");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("# Release brief: Acme (v3), internal technical edition");
    expect(r.content).toContain("not a deployment approval");
    expect(r.content).toContain("**Affected user groups:** Admins");
    expect(r.content).toContain("## Risks and items not yet verified");
    expect(r.content).toContain("## Known limitations");
    expect(r.content).toContain("## Required actions");
    expect(r.content).toMatch(/_\(sources: F-1, Q-1\)_/);
  });

  it("builds the stakeholder edition from stakeholder statements only", async () => {
    const { brief } = await setup();
    const r = brief("stakeholder");
    expect(r.ok && r.content).toContain("stakeholder edition");
    expect(r.ok && r.content).not.toContain("QA:");
  });

  it("excludes rejected statements from the content", async () => {
    const { brief, statements } = await setup();
    const sts = statements.map((s) => (s.audience === "internal" && s.section === "migration" ? { ...s, status: "rejected" as const } : s));
    const r = brief("internal", sts);
    expect(r.ok).toBe(true); // migration notes are not a required-coverage item
    expect(r.ok && r.content).not.toContain("Required actions");
  });

  it("refuses while any statement for the audience is still a draft", async () => {
    const { brief, statements } = await setup();
    const sts = statements.map((s, i) => (i === 0 ? { ...s, status: "draft" as const } : s));
    const r = brief(sts[0]!.audience, sts);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.errors.join(" ")).toContain("still drafts");
  });

  it("does not let drafts of the OTHER audience block this audience's brief", async () => {
    const { brief, statements } = await setup();
    const sts = statements.map((s) => (s.audience === "stakeholder" ? { ...s, status: "draft" as const } : s));
    expect(brief("internal", sts).ok).toBe(true);
  });

  it("refuses if the risk statement for an unverified item was rejected", async () => {
    const { brief, statements } = await setup();
    const sts = statements.map((s) => (s.audience === "internal" && s.section === "risk" ? { ...s, status: "rejected" as const } : s));
    const r = brief("internal", sts);
    expect(!r.ok && r.errors.join(" ")).toContain("no approved risk statement covers it");
  });

  it("refuses if a known limitation is no longer covered", async () => {
    const { brief, statements } = await setup();
    const sts = statements.map((s) => (s.audience === "internal" && s.section === "limitation" ? { ...s, status: "rejected" as const } : s));
    const r = brief("internal", sts);
    expect(!r.ok && r.errors.join(" ")).toContain("Known limitation L-1");
  });

  it("refuses if a release item has no approved statement", async () => {
    const { brief, statements } = await setup();
    const sts = statements.filter((s) => !(s.audience === "internal" && s.citations.includes("B-1") && s.section === "change"));
    const r = brief("internal", sts);
    expect(!r.ok && r.errors.join(" ")).toContain('B-1 "Fix login redirect loop" is not covered');
  });

  it("refuses to publish approved statements whose sources have changed", async () => {
    const { brief, statements, pkg, checks } = await setup();
    const changed = collectItems(parsePackage({ ...risky(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 50k rows" }, { id: "F-2", title: "Dark mode" }] }));
    void pkg; void checks;
    const r = brief("internal", statements, { items: changed });
    expect(!r.ok && r.errors.join(" ")).toContain("stale");
  });

  it("refuses when the package has blocking findings, or no statements exist", async () => {
    const { brief, items, statements } = await setup();
    const notReady = { findings: [], ready: false };
    expect(brief("internal", statements, { checks: notReady }).ok).toBe(false);
    expect(brief("internal", []).ok).toBe(false);
    void items;
  });
});
