import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "../src/checks.js";
import { collectItems } from "../src/items.js";
import { MockProvider } from "../src/llm/mock.js";
import { generateReview } from "../src/llm/pipeline.js";
import { buildSummarizePrompt } from "../src/llm/prompts.js";
import type { LlmProvider } from "../src/llm/types.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

describe("summaries are generated in parallel", () => {
  it("runs the two audience summaries concurrently and keeps internal statements first", async () => {
    const real = new MockProvider();
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: LlmProvider = {
      name: "slow",
      async completeJson(req) {
        if (req.task === "summarize") {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
        }
        await new Promise((r) => setTimeout(r, 40));
        const out = await real.completeJson(req);
        if (req.task === "summarize") inFlight--;
        return out;
      },
    };
    const pkg = parsePackage(goodPackage());
    const review = await generateReview(slow, pkg, runDeterministicChecks(pkg));
    expect(maxInFlight).toBe(2);
    const firstStakeholder = review.statements.findIndex((s) => s.audience === "stakeholder");
    expect(firstStakeholder).toBeGreaterThan(0);
    expect(review.statements.slice(0, firstStakeholder).every((s) => s.audience === "internal")).toBe(true);
    expect(review.statements.slice(firstStakeholder).every((s) => s.audience === "stakeholder")).toBe(true);
  });

  it("still fails the whole review if one audience cannot be generated", async () => {
    const real = new MockProvider();
    const flaky: LlmProvider = {
      name: "flaky",
      async completeJson(req) {
        if (req.task === "summarize" && (req.input as { audience: string }).audience === "stakeholder") return { statements: [] };
        return real.completeJson(req);
      },
    };
    const pkg = parsePackage(goodPackage());
    await expect(generateReview(flaky, pkg, runDeterministicChecks(pkg))).rejects.toMatchObject({ name: "GenerationError" });
  });
});

describe("summary prompt", () => {
  it("tells the model not to restate unverified claims as fact", () => {
    const pkg = parsePackage(goodPackage());
    const p = buildSummarizePrompt("stakeholder", pkg, collectItems(pkg), [], {});
    expect(p.system).toContain("Never restate an unsupported or weakly evidenced claim as fact");
  });
});
