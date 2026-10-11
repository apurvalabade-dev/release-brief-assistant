import { createHash } from "node:crypto";

/** JSON.stringify with sorted keys and undefined dropped, so equal content always gives equal output. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export const hashOf = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
