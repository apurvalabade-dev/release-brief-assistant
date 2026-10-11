import { describe, expect, it } from "vitest";
import { diffPackages } from "../src/diff.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

const diff = (a: unknown, b: unknown) => diffPackages(parsePackage(a), parsePackage(b));

describe("diffPackages", () => {
  it("reports no changes for identical packages", () => {
    const d = diff(goodPackage(), goodPackage());
    expect(d.hasChanges).toBe(false);
    expect(d.sections).toEqual([]);
    expect(d.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("detects an added item", () => {
    const b = { ...goodPackage(), completedFeatures: [...goodPackage().completedFeatures, { id: "F-2", title: "Dark mode" }] };
    const d = diff(goodPackage(), b);
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0]).toMatchObject({ section: "completedFeatures", removed: [], changed: [] });
    expect(d.sections[0]!.added.map((i) => i.id)).toEqual(["F-2"]);
  });

  it("detects a removed item", () => {
    const d = diff(goodPackage(), { ...goodPackage(), completedFeatures: [] });
    expect(d.sections[0]!.removed.map((i) => i.id)).toEqual(["F-1"]);
  });

  it("reports field-level changes on an item matched by id", () => {
    const b = { ...goodPackage(), completedFeatures: [{ id: "F-1", title: "CSV export", description: "Export up to 50k rows" }] };
    const d = diff(goodPackage(), b);
    expect(d.sections[0]!.changed).toEqual([
      { id: "F-1", label: "CSV export", changes: [{ field: "description", from: "Export up to 10k rows", to: "Export up to 50k rows" }] },
    ]);
  });

  it("detects QA result changes", () => {
    const b = goodPackage();
    b.qaSummary[0] = { id: "Q-1", summary: "Export verified on 3 browsers", result: "fail" as never, covers: ["F-1"] };
    const d = diff(goodPackage(), b);
    const qa = d.sections.find((s) => s.section === "qaSummary")!;
    expect(qa.changed[0]!.changes).toEqual([{ field: "result", from: "pass", to: "fail" }]);
  });

  it("ignores pure reordering of items", () => {
    const a = { ...goodPackage(), bugFixes: [{ id: "B-1", title: "a" }, { id: "B-2", title: "b" }] };
    const b = { ...goodPackage(), bugFixes: [{ id: "B-2", title: "b" }, { id: "B-1", title: "a" }] };
    expect(diff(a, b).hasChanges).toBe(false);
  });

  it("tracks user groups and confirmation flags", () => {
    const b = { ...goodPackage(), affectedUserGroups: ["Admins", "Clients"], noMigrationRequiredConfirmed: false };
    const d = diff(goodPackage(), b);
    expect(d.userGroups).toEqual({ added: ["Clients"], removed: [] });
    expect(d.flags).toEqual([{ field: "noMigrationRequiredConfirmed", from: true, to: false }]);
    expect(d.summary).toEqual({ added: 1, removed: 0, changed: 1 });
  });
});
