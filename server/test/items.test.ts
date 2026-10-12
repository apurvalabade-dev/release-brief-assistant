import { describe, expect, it } from "vitest";
import { collectItems, freshness, sourceHashFor } from "../src/items.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

const items = (raw: unknown) => collectItems(parsePackage(raw));

describe("collectItems", () => {
  it("lists every citable item with its kind", () => {
    const list = items(goodPackage());
    expect(list.map((i) => `${i.id}:${i.kind}`)).toEqual(["F-1:feature", "B-1:bugfix", "Q-1:qa", "Q-2:qa", "L-1:limitation"]);
  });

  it("gives identical hashes for identical content", () => {
    expect(items(goodPackage()).map((i) => i.hash)).toEqual(items(goodPackage()).map((i) => i.hash));
  });
});

describe("freshness (staleness detection)", () => {
  const v1 = items(goodPackage());
  const cited = ["F-1", "Q-1"];
  const stored = sourceHashFor(cited, v1)!;

  it("is fresh when nothing cited has changed", () => {
    expect(freshness(stored, cited, items(goodPackage()))).toBe("fresh");
  });

  it("is fresh when only an UNCITED item changed", () => {
    const pkg = goodPackage();
    pkg.bugFixes = [{ title: "Totally different bug fix" }];
    expect(freshness(stored, cited, items(pkg))).toBe("fresh");
  });

  it("goes stale when a cited item's content changes", () => {
    const pkg = goodPackage();
    pkg.completedFeatures = [{ id: "F-1", title: "CSV export", description: "Export up to 50k rows" }];
    expect(freshness(stored, cited, items(pkg))).toBe("stale");
  });

  it("goes stale when cited QA evidence changes result", () => {
    const pkg = goodPackage();
    pkg.qaSummary[0] = { id: "Q-1", summary: "Export verified on 3 browsers", result: "fail" as never, covers: ["F-1"] };
    expect(freshness(stored, cited, items(pkg))).toBe("stale");
  });

  it("reports source_removed when a cited item no longer exists", () => {
    const pkg = goodPackage();
    pkg.completedFeatures = [];
    expect(freshness(stored, cited, items(pkg))).toBe("source_removed");
  });

  it("goes stale when QA evidence is ADDED for a cited item (even though the item itself is unchanged)", () => {
    const f2 = ["F-2"];
    const before = { ...goodPackage(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "" }, { id: "F-2", title: "Dark mode", description: "" }] };
    const storedF2 = sourceHashFor(f2, items(before))!;
    const after = { ...before, qaSummary: [...before.qaSummary, { id: "Q-3", summary: "Dark mode verified", result: "pass" as const, covers: ["F-2"] }] };
    expect(freshness(storedF2, f2, items(after))).toBe("stale");
  });

  it("goes stale when evidence covering a cited item is removed or changes result", () => {
    const f1 = ["F-1"];
    const stored = sourceHashFor(f1, v1)!;
    const removed = goodPackage();
    removed.qaSummary = removed.qaSummary.filter((q) => q.id !== "Q-1");
    expect(freshness(stored, f1, items(removed))).toBe("stale");
    const failed = goodPackage();
    failed.qaSummary[0] = { id: "Q-1", summary: "Export verified on 3 browsers", result: "fail" as never, covers: ["F-1"] };
    expect(freshness(stored, f1, items(failed))).toBe("stale");
  });

  it("stays fresh when evidence for a DIFFERENT item changes", () => {
    const f1 = ["F-1"];
    const stored = sourceHashFor(f1, v1)!;
    const pkg = goodPackage();
    pkg.qaSummary[1] = { id: "Q-2", summary: "Login regression suite", result: "fail" as never, covers: ["B-1"] };
    expect(freshness(stored, f1, items(pkg))).toBe("fresh");
  });

  it("does not depend on the order of cited ids", () => {
    expect(sourceHashFor(["Q-1", "F-1"], v1)).toBe(sourceHashFor(["F-1", "Q-1", "F-1"], v1));
  });
});
