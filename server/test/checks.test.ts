import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "../src/checks.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

const run = (raw: unknown) => runDeterministicChecks(parsePackage(raw));
const codes = (raw: unknown) => run(raw).findings.map((f) => f.code);

describe("runDeterministicChecks", () => {
  it("passes a complete, supported package with no findings", () => {
    const r = run(goodPackage());
    expect(r.findings).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it("is deterministic", () => {
    expect(run(goodPackage())).toEqual(run(goodPackage()));
  });

  it("flags an empty package as not ready", () => {
    const r = run({});
    expect(r.ready).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["NO_CHANGES", "NO_QA_EVIDENCE", "NO_AFFECTED_USER_GROUPS", "LIMITATIONS_MISSING"]),
    );
  });

  it("requires limitations unless explicitly confirmed as none", () => {
    expect(codes({ ...goodPackage(), knownLimitations: [] })).toContain("LIMITATIONS_MISSING");
    expect(codes({ ...goodPackage(), knownLimitations: [], noKnownLimitationsConfirmed: true })).not.toContain("LIMITATIONS_MISSING");
  });

  it("requires migration notes when behaviour changed", () => {
    const base = { ...goodPackage(), changedBehaviour: [{ id: "C-1", title: "Default timeout now 30s" }], noMigrationRequiredConfirmed: false };
    expect(codes(base)).toContain("MIGRATION_NOTES_MISSING");
    expect(codes({ ...base, migrationNotes: [{ description: "Set TIMEOUT_MS to keep old value" }] })).not.toContain("MIGRATION_NOTES_MISSING");
    expect(codes({ ...base, noMigrationRequiredConfirmed: true })).not.toContain("MIGRATION_NOTES_MISSING");
  });

  it("does not demand migration notes when no behaviour changed", () => {
    expect(codes({ ...goodPackage(), noMigrationRequiredConfirmed: false })).not.toContain("MIGRATION_NOTES_MISSING");
  });

  it("warns (without blocking) on items with no QA evidence", () => {
    const r = run({ ...goodPackage(), completedFeatures: [{ id: "F-1", title: "CSV export" }, { id: "F-2", title: "Dark mode" }] });
    const f = r.findings.find((x) => x.code === "ITEM_WITHOUT_QA");
    expect(f).toMatchObject({ itemId: "F-2", severity: "warning" });
    expect(r.ready).toBe(true);
  });

  it("warns when the only covering evidence failed or did not run", () => {
    const pkg = goodPackage();
    pkg.qaSummary[0] = { id: "Q-1", summary: "Export tests", result: "fail" as never, covers: ["F-1"] };
    expect(run(pkg).findings.find((x) => x.code === "ITEM_QA_NOT_PASSING")?.itemId).toBe("F-1");
  });

  it("accepts an item if at least one covering evidence passed", () => {
    const pkg = goodPackage();
    pkg.qaSummary.push({ id: "Q-3", summary: "Edge case run", result: "partial" as never, covers: ["F-1"] });
    expect(codes(pkg)).not.toContain("ITEM_QA_NOT_PASSING");
  });

  it("errors on QA evidence pointing at an unknown item", () => {
    const pkg = goodPackage();
    pkg.qaSummary[0] = { id: "Q-1", summary: "x", result: "pass" as never, covers: ["F-99"] };
    const r = run(pkg);
    expect(r.findings.some((f) => f.code === "QA_UNKNOWN_REFERENCE")).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("errors on duplicate ids", () => {
    expect(codes({ ...goodPackage(), bugFixes: [{ id: "F-1", title: "clash" }] })).toContain("DUPLICATE_ID");
  });
});
