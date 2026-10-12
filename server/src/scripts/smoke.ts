/**
 * Runs the real generation pipeline once against whatever provider is configured in .env and
 * prints what came back. Use it to check a new API key and to see how a real model behaves:
 *   npm run smoke:llm                 (uses LLM_PROVIDER from .env; "mock" works with no key)
 *
 * The sample package contains a claim the deterministic checks CANNOT catch: F-1 says "10x
 * faster and fully load-tested" but the only evidence is a 100-row smoke test that passed.
 * Only a model reading the wording can flag that, so watch the "unsupported claims" output.
 */
import { runDeterministicChecks } from "../checks.js";
import { loadConfig } from "../config.js";
import { createProvider } from "../llm/index.js";
import { GenerationError, generateReview } from "../llm/pipeline.js";
import { parsePackage } from "../schema.js";

const sample = {
  completedFeatures: [
    { id: "F-1", title: "Faster CSV export", description: "Export is now 10x faster and fully load-tested for large accounts." },
    { id: "F-2", title: "Dark mode", description: "Optional dark theme in settings." },
  ],
  bugFixes: [{ id: "B-1", title: "Fix login redirect loop", description: "Users on SSO no longer bounce between login pages." }],
  changedBehaviour: [{ id: "C-1", title: "Session timeout is now 30 minutes", description: "Previously 8 hours." }],
  qaSummary: [
    { id: "Q-1", summary: "Smoke test: exported 100 rows on staging, file opened correctly", result: "pass", covers: ["F-1"] },
    { id: "Q-2", summary: "SSO login regression suite", result: "pass", covers: ["B-1"] },
    { id: "Q-3", summary: "Session timeout manual check", result: "partial", covers: ["C-1"] },
  ],
  knownLimitations: [{ id: "L-1", description: "Dark mode does not yet cover the admin console." }],
  migrationNotes: [{ id: "M-1", description: "Set SESSION_TIMEOUT_MINUTES=480 to keep the old 8-hour behaviour." }],
  affectedUserGroups: ["Admins", "End users"],
};

async function main() {
  const config = loadConfig();
  const provider = createProvider(config);
  const pkg = parsePackage(sample);
  const checks = runDeterministicChecks(pkg);
  console.log(`provider: ${provider.name}`);
  console.log(`deterministic checks: ready=${checks.ready}, findings=${checks.findings.map((f) => `${f.code}${f.itemId ? `(${f.itemId})` : ""}`).join(", ") || "none"}\n`);

  const started = Date.now();
  const review = await generateReview(provider, pkg, checks);
  console.log(`generated in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  console.log("classifications:");
  for (const c of review.classifications) console.log(`  ${c.itemId.padEnd(4)} ${c.impact.padEnd(13)} ${c.rationale}`);
  console.log("\ngaps:");
  for (const g of review.gaps) console.log(`  - ${g.message}`);
  if (!review.gaps.length) console.log("  (none)");
  console.log("\nunsupported claims:");
  for (const u of review.unsupportedClaims) console.log(`  ${u.itemId} [${u.source}] ${u.reason}`);
  if (!review.unsupportedClaims.length) console.log("  (none)");
  for (const audience of ["internal", "stakeholder"] as const) {
    console.log(`\n${audience} statements:`);
    for (const s of review.statements.filter((x) => x.audience === audience)) console.log(`  [${s.section.padEnd(10)}] ${s.text}  <- ${s.citations.join(", ")}`);
  }
  const modelFlagged = review.unsupportedClaims.some((u) => u.itemId === "F-1" && u.source === "model");
  console.log(`\nmodel caught the unsupported "10x faster / fully load-tested" claim on F-1: ${modelFlagged ? "YES" : "no (expected with the mock provider)"}`);
}

main().catch((err) => {
  if (err instanceof GenerationError) {
    console.error(`\nGENERATION FAILED: ${err.message}`);
    for (const d of err.details) console.error(`  - ${d}`);
  } else {
    console.error(`\nERROR: ${(err as Error).message}`);
  }
  process.exit(1);
});
