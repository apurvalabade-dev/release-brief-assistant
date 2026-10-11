import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "../src/checks.js";
import { collectItems } from "../src/items.js";
import { MockProvider } from "../src/llm/mock.js";
import { GenerationError, generateReview } from "../src/llm/pipeline.js";
import { buildAnalyzePrompt, buildSummarizePrompt } from "../src/llm/prompts.js";
import type { LlmProvider, LlmRequest } from "../src/llm/types.js";
import { validateStatements } from "../src/llm/validate.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

const prep = (raw: unknown) => {
  const pkg = parsePackage(raw);
  return { pkg, checks: runDeterministicChecks(pkg), items: collectItems(pkg) };
};

/** A package with one unsupported feature (F-2 has no QA) and a migration note. */
const riskyPackage = () => ({
  ...goodPackage(),
  completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 10k rows" }, { id: "F-2", title: "Dark mode" }],
  migrationNotes: [{ description: "Set EXPORT_LIMIT env var" }],
});

describe("validateStatements", () => {
  const { items } = prep(goodPackage());
  const ok = { statements: [
    { section: "change" as const, text: "x", citations: ["F-1"] },
    { section: "limitation" as const, text: "y", citations: ["L-1"] },
  ] };

  it("accepts statements with real citations covering all limitations", () => {
    expect(validateStatements(ok, items, { flaggedItemIds: [] })).toEqual([]);
  });

  it("rejects unknown citations", () => {
    const bad = { statements: [...ok.statements, { section: "change" as const, text: "z", citations: ["F-99"] }] };
    expect(validateStatements(bad, items, { flaggedItemIds: [] })).toEqual(['statement 3 cites unknown item "F-99"']);
  });

  it("requires every known limitation to be mentioned", () => {
    const missing = { statements: [ok.statements[0]!] };
    expect(validateStatements(missing, items, { flaggedItemIds: [] })).toEqual(['known limitation "L-1" is not mentioned in any statement']);
  });

  it("requires a risk statement for each flagged item", () => {
    expect(validateStatements(ok, items, { flaggedItemIds: ["F-1"] })).toEqual(['item "F-1" lacks supporting QA evidence but no "risk" statement cites it']);
  });

  it("requires limitation statements to cite a limitation", () => {
    const bad = { statements: [{ section: "limitation" as const, text: "y", citations: ["F-1"] }, { section: "change" as const, text: "c", citations: ["L-1"] }] };
    expect(validateStatements(bad, items, { flaggedItemIds: [] })).toEqual(["statement 1 is a limitation but does not cite a limitation item"]);
  });
});

describe("generateReview with the mock provider", () => {
  it("produces valid, fully cited statements for both audiences", async () => {
    const { pkg, checks, items } = prep(goodPackage());
    const r = await generateReview(new MockProvider(), pkg, checks);
    const ids = new Set(items.map((i) => i.id));
    expect(new Set(r.statements.map((s) => s.audience))).toEqual(new Set(["internal", "stakeholder"]));
    for (const s of r.statements) {
      expect(s.citations.length).toBeGreaterThan(0);
      expect(s.citations.every((c) => ids.has(c))).toBe(true);
      expect(s.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(r.classifications.map((c) => c.itemId).sort()).toEqual(["B-1", "F-1"]);
  });

  it("is deterministic", async () => {
    const { pkg, checks } = prep(riskyPackage());
    expect(await generateReview(new MockProvider(), pkg, checks)).toEqual(await generateReview(new MockProvider(), pkg, checks));
  });

  it("surfaces unsupported items as risks for both audiences and lists them as deterministic claims", async () => {
    const { pkg, checks } = prep(riskyPackage());
    const r = await generateReview(new MockProvider(), pkg, checks);
    expect(r.unsupportedClaims).toMatchObject([{ itemId: "F-2", source: "deterministic" }]);
    for (const audience of ["internal", "stakeholder"] as const) {
      const risks = r.statements.filter((s) => s.audience === audience && s.section === "risk");
      expect(risks.some((s) => s.citations.includes("F-2"))).toBe(true);
    }
  });

  it("keeps stakeholder text free of item ids and includes limitations and migration steps", async () => {
    const { pkg, checks } = prep(riskyPackage());
    const r = await generateReview(new MockProvider(), pkg, checks);
    const stake = r.statements.filter((s) => s.audience === "stakeholder");
    expect(stake.every((s) => !/\b[A-Z]-\d+\b/.test(s.text))).toBe(true);
    expect(stake.some((s) => s.section === "limitation")).toBe(true);
    expect(stake.some((s) => s.section === "migration")).toBe(true);
  });
});

/** Wraps the mock, letting a test corrupt chosen responses. */
function flaky(corrupt: (req: LlmRequest, call: number) => unknown | undefined) {
  const real = new MockProvider();
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: "flaky",
    async completeJson(req) {
      calls.push(req);
      return corrupt(req, calls.length) ?? real.completeJson(req);
    },
  };
  return { provider, calls };
}

describe("generateReview failure handling", () => {
  it("retries once with the validation problems in the prompt, then succeeds", async () => {
    const { pkg, checks } = prep(goodPackage());
    const { provider, calls } = flaky((req, n) => (req.task === "summarize" && n === 2 ? { statements: [{ section: "change", text: "x", citations: ["NOPE-1"] }] } : undefined));
    const r = await generateReview(provider, pkg, checks);
    expect(r.statements.length).toBeGreaterThan(0);
    const retry = calls.filter((c) => c.task === "summarize")[1]!;
    expect(retry.user).toContain('cites unknown item "NOPE-1"');
  });

  it("fails with GenerationError if the answer stays invalid", async () => {
    const { pkg, checks } = prep(goodPackage());
    const { provider } = flaky((req) => (req.task === "summarize" ? { statements: [{ section: "change", text: "x", citations: [] }] } : undefined));
    await expect(generateReview(provider, pkg, checks)).rejects.toBeInstanceOf(GenerationError);
  });

  it("rejects non-JSON-shaped output", async () => {
    const { pkg, checks } = prep(goodPackage());
    const { provider } = flaky(() => "I think this release looks great!");
    await expect(generateReview(provider, pkg, checks)).rejects.toThrow(/analysis failed validation/);
  });

  it("wraps provider outages in GenerationError without retrying", async () => {
    const { pkg, checks } = prep(goodPackage());
    let calls = 0;
    const down: LlmProvider = { name: "down", completeJson: async () => { calls++; throw new Error("503 from upstream"); } };
    await expect(generateReview(down, pkg, checks)).rejects.toMatchObject({ name: "GenerationError", details: ["503 from upstream"] });
    expect(calls).toBe(1);
  });

  it("does not let the model hide an unsupported item", async () => {
    const { pkg, checks } = prep(riskyPackage());
    // The model claims nothing is unsupported; the deterministic finding must survive.
    const { provider } = flaky((req) => {
      if (req.task !== "analyze") return undefined;
      const real = (req.input as any).package;
      return {
        classifications: [...real.completedFeatures, ...real.bugFixes].map((i: any) => ({ itemId: i.id, impact: "user_visible", rationale: "r" })),
        gaps: [],
        unsupportedClaims: [],
      };
    });
    const r = await generateReview(provider, pkg, checks);
    expect(r.unsupportedClaims.map((u) => u.itemId)).toEqual(["F-2"]);
  });

  it("rejects an analysis that skips or invents items", async () => {
    const { pkg, checks } = prep(goodPackage());
    const { provider } = flaky((req) => (req.task === "analyze" ? { classifications: [{ itemId: "F-1", impact: "internal", rationale: "r" }, { itemId: "X-9", impact: "internal", rationale: "r" }], gaps: [], unsupportedClaims: [] } : undefined));
    await expect(generateReview(provider, pkg, checks)).rejects.toMatchObject({ details: expect.arrayContaining(['change item "B-1" has no classification', expect.stringContaining('"X-9"')]) });
  });
});

describe("prompts", () => {
  const { pkg, checks, items } = prep(riskyPackage());

  it("include item ids, hard rules and the no-approval rule", () => {
    const p = buildAnalyzePrompt(pkg, items, checks.findings);
    expect(p.user).toContain('"F-2"');
    expect(p.system).toContain("Only cite item ids");
    expect(p.system).toContain("must never say that a release is approved");
  });

  it("differ by audience and carry retry feedback", () => {
    const internal = buildSummarizePrompt("internal", pkg, items, checks.findings, {});
    const stake = buildSummarizePrompt("stakeholder", pkg, items, checks.findings, {}, ["bad thing"]);
    expect(internal.system).toContain("internal technical users");
    expect(stake.system).toContain("non-technical stakeholders");
    expect(stake.user).toContain("- bad thing");
    expect(internal.user).not.toContain("rejected");
  });
});
