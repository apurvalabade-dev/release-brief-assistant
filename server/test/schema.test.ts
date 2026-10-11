import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { hashOf, stableStringify } from "../src/hash.js";
import { parsePackage } from "../src/schema.js";
import { goodPackage } from "./fixtures.js";

describe("parsePackage", () => {
  it("keeps supplied ids and fills missing ones without collisions", () => {
    const pkg = parsePackage({ ...goodPackage(), bugFixes: [{ title: "a" }, { id: "B-1", title: "b" }, { title: "c" }] });
    expect(pkg.bugFixes.map((b) => b.id)).toEqual(["B-2", "B-1", "B-3"]);
  });

  it("is stable when re-parsing an already normalized package", () => {
    const once = parsePackage(goodPackage());
    expect(parsePackage(once)).toEqual(once);
  });

  it("accepts an empty object (every section defaults to empty)", () => {
    const pkg = parsePackage({});
    expect(pkg.completedFeatures).toEqual([]);
    expect(pkg.noKnownLimitationsConfirmed).toBe(false);
  });

  it("rejects blank text, bad ids and bad QA results with a ZodError", () => {
    expect(() => parsePackage({ completedFeatures: [{ title: "   " }] })).toThrow(ZodError);
    expect(() => parsePackage({ completedFeatures: [{ id: "feature1", title: "x" }] })).toThrow(ZodError);
    expect(() => parsePackage({ qaSummary: [{ summary: "x", result: "great" }] })).toThrow(ZodError);
  });

  it("rejects non-object input", () => {
    expect(() => parsePackage("nope")).toThrow(ZodError);
    expect(() => parsePackage(null)).toThrow(ZodError);
  });
});

describe("hashing", () => {
  it("ignores key order and undefined values", () => {
    expect(hashOf({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashOf({ b: { d: [1, 2], c: 2 }, a: 1, x: undefined }));
  });

  it("changes when content changes, and array order matters", () => {
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
