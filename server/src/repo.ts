import type pg from "pg";
import type { CheckResult } from "./checks.js";
import { hashOf } from "./hash.js";
import type { GeneratedReview } from "./llm/pipeline.js";
import type { NormalizedPackage } from "./schema.js";

export interface ReleaseRow {
  id: number;
  name: string;
  createdAt: string;
  latestVersion: number;
}
export interface VersionRow {
  releaseId: number;
  versionNo: number;
  package: NormalizedPackage;
  packageHash: string;
  createdAt: string;
}
export interface VersionSummary {
  versionNo: number;
  packageHash: string;
  createdAt: string;
}

const toVersion = (r: any): VersionRow => ({
  releaseId: r.release_id,
  versionNo: r.version_no,
  package: r.package,
  packageHash: r.package_hash,
  createdAt: new Date(r.created_at).toISOString(),
});

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function audit(c: pg.PoolClient, releaseId: number, versionId: number, action: string, detail: unknown) {
  // version_id FK is on release_versions.id; detail carries the human-readable release/version numbers.
  await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'human', $2, $3)", [versionId, action, JSON.stringify({ releaseId, ...(detail as object) })]);
}

export async function createRelease(pool: pg.Pool, name: string, pkg: NormalizedPackage): Promise<{ release: { id: number; name: string }; version: VersionRow }> {
  return inTransaction(pool, async (c) => {
    const rel = await c.query("INSERT INTO releases (name) VALUES ($1) RETURNING id, name", [name]);
    const hash = hashOf(pkg);
    const v = await c.query(
      "INSERT INTO release_versions (release_id, version_no, package, package_hash) VALUES ($1, 1, $2, $3) RETURNING id, release_id, version_no, package, package_hash, created_at",
      [rel.rows[0].id, JSON.stringify(pkg), hash],
    );
    await audit(c, rel.rows[0].id, v.rows[0].id, "release_created", { versionNo: 1 });
    return { release: rel.rows[0], version: toVersion(v.rows[0]) };
  });
}

/**
 * Appends a new immutable version. If the package is identical to the latest version
 * nothing is written (created = false). The release row is locked so concurrent
 * saves get distinct, gapless version numbers.
 */
export async function addVersion(pool: pg.Pool, releaseId: number, pkg: NormalizedPackage): Promise<{ created: boolean; version: VersionRow } | null> {
  return inTransaction(pool, async (c) => {
    const locked = await c.query("SELECT id FROM releases WHERE id = $1 FOR UPDATE", [releaseId]);
    if (locked.rowCount === 0) return null;
    const latest = await c.query("SELECT id, release_id, version_no, package, package_hash, created_at FROM release_versions WHERE release_id = $1 ORDER BY version_no DESC LIMIT 1", [releaseId]);
    const hash = hashOf(pkg);
    if (latest.rows[0]?.package_hash === hash) return { created: false, version: toVersion(latest.rows[0]) };
    const next = (latest.rows[0]?.version_no ?? 0) + 1;
    const v = await c.query(
      "INSERT INTO release_versions (release_id, version_no, package, package_hash) VALUES ($1, $2, $3, $4) RETURNING id, release_id, version_no, package, package_hash, created_at",
      [releaseId, next, JSON.stringify(pkg), hash],
    );
    await audit(c, releaseId, v.rows[0].id, "version_created", { versionNo: next });
    return { created: true, version: toVersion(v.rows[0]) };
  });
}

export async function listReleases(pool: pg.Pool): Promise<ReleaseRow[]> {
  const r = await pool.query(
    `SELECT r.id, r.name, r.created_at, COALESCE(MAX(v.version_no), 0) AS latest
       FROM releases r LEFT JOIN release_versions v ON v.release_id = r.id
      GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC`,
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, createdAt: new Date(x.created_at).toISOString(), latestVersion: Number(x.latest) }));
}

export async function getRelease(pool: pg.Pool, id: number): Promise<{ id: number; name: string; createdAt: string; versions: VersionSummary[] } | null> {
  const r = await pool.query("SELECT id, name, created_at FROM releases WHERE id = $1", [id]);
  if (r.rowCount === 0) return null;
  const v = await pool.query("SELECT version_no, package_hash, created_at FROM release_versions WHERE release_id = $1 ORDER BY version_no", [id]);
  return {
    id: r.rows[0].id,
    name: r.rows[0].name,
    createdAt: new Date(r.rows[0].created_at).toISOString(),
    versions: v.rows.map((x) => ({ versionNo: x.version_no, packageHash: x.package_hash, createdAt: new Date(x.created_at).toISOString() })),
  };
}

export async function getVersion(pool: pg.Pool, releaseId: number, versionNo: number): Promise<VersionRow | null> {
  const r = await pool.query("SELECT release_id, version_no, package, package_hash, created_at FROM release_versions WHERE release_id = $1 AND version_no = $2", [releaseId, versionNo]);
  return r.rows[0] ? toVersion(r.rows[0]) : null;
}

// ---------------------------------------------------------------- reviews (analysis + statements)


export interface StoredStatement {
  id: number;
  audience: "internal" | "stakeholder";
  section: "change" | "risk" | "limitation" | "migration";
  position: number;
  text: string;
  citations: string[];
  sourceHash: string;
  status: "draft" | "approved" | "rejected";
  editedByHuman: boolean;
}
export interface StoredReview {
  analysis: {
    model: string | null;
    createdAt: string;
    deterministic: CheckResult;
    classifications: GeneratedReview["classifications"];
    gaps: GeneratedReview["gaps"];
    unsupportedClaims: GeneratedReview["unsupportedClaims"];
  };
  statements: StoredStatement[];
}

export async function getReview(pool: pg.Pool, releaseId: number, versionNo: number): Promise<StoredReview | null> {
  const v = await pool.query("SELECT id FROM release_versions WHERE release_id = $1 AND version_no = $2", [releaseId, versionNo]);
  if (v.rowCount === 0) return null;
  const versionId = v.rows[0].id;
  const a = await pool.query("SELECT model, created_at, deterministic, classifications, gaps, unsupported_claims FROM analyses WHERE version_id = $1", [versionId]);
  if (a.rowCount === 0) return null;
  const s = await pool.query(
    "SELECT id, audience, section, position, text, cited_item_ids, source_hash, status, edited_by_human FROM statements WHERE version_id = $1 ORDER BY audience, position",
    [versionId],
  );
  const row = a.rows[0];
  return {
    analysis: {
      model: row.model,
      createdAt: new Date(row.created_at).toISOString(),
      deterministic: row.deterministic,
      classifications: row.classifications ?? [],
      gaps: row.gaps ?? [],
      unsupportedClaims: row.unsupported_claims ?? [],
    },
    statements: s.rows.map((x) => ({
      id: x.id,
      audience: x.audience,
      section: x.section,
      position: x.position,
      text: x.text,
      citations: x.cited_item_ids,
      sourceHash: x.source_hash,
      status: x.status,
      editedByHuman: x.edited_by_human,
    })),
  };
}

export type SaveReviewResult = "saved" | "not_found" | "exists" | "has_reviewed_content";

/**
 * Stores a generated review as DRAFT statements. Never marks anything approved:
 * approval is a separate, human-only action. Regenerating is refused if a human
 * has already approved, rejected or edited anything for this version.
 */
export async function saveReview(pool: pg.Pool, releaseId: number, versionNo: number, checks: CheckResult, review: GeneratedReview, regenerate: boolean): Promise<SaveReviewResult> {
  return inTransaction(pool, async (c) => {
    const v = await c.query("SELECT id FROM release_versions WHERE release_id = $1 AND version_no = $2 FOR UPDATE", [releaseId, versionNo]);
    if (v.rowCount === 0) return "not_found";
    const versionId = v.rows[0].id;

    const existing = await c.query("SELECT status, edited_by_human FROM statements WHERE version_id = $1", [versionId]);
    const hasAnalysis = ((await c.query("SELECT 1 FROM analyses WHERE version_id = $1", [versionId])).rowCount ?? 0) > 0;
    if (hasAnalysis || (existing.rowCount ?? 0) > 0) {
      if (!regenerate) return "exists";
      if (existing.rows.some((r) => r.status !== "draft" || r.edited_by_human)) return "has_reviewed_content";
      await c.query("DELETE FROM statements WHERE version_id = $1", [versionId]);
      await c.query("DELETE FROM analyses WHERE version_id = $1", [versionId]);
    }

    await c.query(
      "INSERT INTO analyses (version_id, deterministic, classifications, gaps, unsupported_claims, model) VALUES ($1, $2, $3, $4, $5, $6)",
      [versionId, JSON.stringify(checks), JSON.stringify(review.classifications), JSON.stringify(review.gaps), JSON.stringify(review.unsupportedClaims), review.model],
    );
    for (const s of review.statements) {
      await c.query(
        "INSERT INTO statements (version_id, audience, section, position, text, cited_item_ids, source_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [versionId, s.audience, s.section, s.position, s.text, s.citations, s.sourceHash],
      );
    }
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'system', 'review_generated', $2)", [
      versionId,
      JSON.stringify({ releaseId, versionNo, model: review.model, statements: review.statements.length, regenerated: regenerate }),
    ]);
    return "saved";
  });
}
