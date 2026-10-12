import type pg from "pg";
import type { CheckResult } from "./checks.js";
import { hashOf } from "./hash.js";
import { freshness, sourceHashFor, type PackageItem } from "./items.js";
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

interface StatementInsert {
  audience: string;
  section: string;
  position: number;
  text: string;
  citations: string[];
  sourceHash: string;
  status: string;
  editedByHuman: boolean;
  decidedAt: Date | string | null;
}

/**
 * Inserts any number of statements in ONE query (parallel arrays + unnest), so the number of
 * database round trips does not grow with the number of statements. One round trip can cost
 * 100ms+ on a hosted database, and the old one-INSERT-per-statement loop made a 30-statement
 * review take seconds.
 */
async function insertStatements(c: pg.PoolClient, versionId: number, rows: StatementInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await c.query(
    `INSERT INTO statements (version_id, audience, section, position, text, cited_item_ids, source_hash, status, edited_by_human, decided_at)
     SELECT $1, t.aud, t.sec, t.pos, t.body, ARRAY(SELECT jsonb_array_elements_text(t.cited::jsonb)), t.src, t.st, t.edited, t.decided
       FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::boolean[], $10::timestamptz[])
            WITH ORDINALITY AS t(aud, sec, pos, body, cited, src, st, edited, decided, ord)
      ORDER BY t.ord`,
    [
      versionId,
      rows.map((r) => r.audience),
      rows.map((r) => r.section),
      rows.map((r) => r.position),
      rows.map((r) => r.text),
      rows.map((r) => JSON.stringify(r.citations)),
      rows.map((r) => r.sourceHash),
      rows.map((r) => r.status),
      rows.map((r) => r.editedByHuman),
      rows.map((r) => r.decidedAt),
    ],
  );
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
  /** null for versions whose statements were carried over instead of generated. */
  analysis: null | {
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
  const s = await pool.query(
    `SELECT id, audience, section, position, text, cited_item_ids, source_hash, status, edited_by_human
       FROM statements WHERE version_id = $1 ORDER BY audience, position, id`,
    [versionId],
  );
  if (a.rowCount === 0 && s.rowCount === 0) return null;
  const row = a.rows[0];
  return {
    analysis: row
      ? {
          model: row.model,
          createdAt: new Date(row.created_at).toISOString(),
          deterministic: row.deterministic,
          classifications: row.classifications ?? [],
          gaps: row.gaps ?? [],
          unsupportedClaims: row.unsupported_claims ?? [],
        }
      : null,
    statements: s.rows.map(toStatement),
  };
}

const toStatement = (x: any): StoredStatement => ({
  id: x.id,
  audience: x.audience,
  section: x.section,
  position: x.position,
  text: x.text,
  citations: x.cited_item_ids,
  sourceHash: x.source_hash,
  status: x.status,
  editedByHuman: x.edited_by_human,
});

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
    await insertStatements(
      c,
      versionId,
      review.statements.map((s) => ({ audience: s.audience, section: s.section, position: s.position, text: s.text, citations: s.citations, sourceHash: s.sourceHash, status: "draft", editedByHuman: false, decidedAt: null })),
    );
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'system', 'review_generated', $2)", [
      versionId,
      JSON.stringify({ releaseId, versionNo, model: review.model, statements: review.statements.length, regenerated: regenerate }),
    ]);
    return "saved";
  });
}

// ---------------------------------------------------------------- human review actions


export type UpdateStatementResult =
  | { result: "ok"; statement: StoredStatement }
  | { result: "not_found" }
  | { result: "stale" }
  | { result: "source_removed" };

const STATEMENT_COLUMNS = "s.id, s.audience, s.section, s.position, s.text, s.cited_item_ids, s.source_hash, s.status, s.edited_by_human";

/**
 * Human review action on one statement: edit its text, approve it, reject it, or reset it to draft.
 *  - Editing re-anchors the statement to the current content of its cited items (a human has
 *    re-read it) and resets approval to draft unless a status is given in the same request.
 *  - Approving without editing is refused when the cited items changed since it was written.
 * Citations are never changed by an edit.
 */
export async function updateStatement(
  pool: pg.Pool,
  releaseId: number,
  versionNo: number,
  statementId: number,
  patch: { text?: string | undefined; status?: "draft" | "approved" | "rejected" | undefined },
  items: PackageItem[],
): Promise<UpdateStatementResult> {
  return inTransaction(pool, async (c): Promise<UpdateStatementResult> => {
    const r = await c.query(
      `SELECT ${STATEMENT_COLUMNS}, v.id AS version_id FROM statements s JOIN release_versions v ON v.id = s.version_id
        WHERE s.id = $1 AND v.release_id = $2 AND v.version_no = $3 FOR UPDATE OF s`,
      [statementId, releaseId, versionNo],
    );
    if (r.rowCount === 0) return { result: "not_found" };
    const cur = toStatement(r.rows[0]);
    const state = freshness(cur.sourceHash, cur.citations, items);

    const editing = patch.text !== undefined;
    const newStatus = patch.status ?? (editing ? "draft" : cur.status);
    let sourceHash = cur.sourceHash;
    let text = cur.text;
    let edited = cur.editedByHuman;

    if (editing) {
      if (state === "source_removed") return { result: "source_removed" };
      text = patch.text!;
      edited = edited || text !== cur.text;
      sourceHash = sourceHashFor(cur.citations, items)!;
    } else if (newStatus === "approved" && state !== "fresh") {
      return state === "stale" ? { result: "stale" } : { result: "source_removed" };
    }

    const decided = newStatus === "approved" || newStatus === "rejected";
    const u = await c.query(
      `UPDATE statements SET text = $2, source_hash = $3, status = $4, edited_by_human = $5, decided_at = ${decided ? "now()" : "NULL"}
        WHERE id = $1 RETURNING id, audience, section, position, text, cited_item_ids, source_hash, status, edited_by_human`,
      [statementId, text, sourceHash, newStatus, edited],
    );
    const action = editing ? "statement_edited" : newStatus === "approved" ? "statement_approved" : newStatus === "rejected" ? "statement_rejected" : "statement_reset";
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'human', $2, $3)", [
      r.rows[0].version_id,
      action,
      JSON.stringify({ releaseId, versionNo, statementId, before: { text: cur.text, status: cur.status }, after: { text, status: newStatus } }),
    ]);
    return { result: "ok", statement: toStatement(u.rows[0]) };
  });
}

/** A human-authored statement (e.g. for an item added after a carry-over). Always starts as a draft. */
export async function addStatement(
  pool: pg.Pool,
  releaseId: number,
  versionNo: number,
  s: { audience: "internal" | "stakeholder"; section: StoredStatement["section"]; text: string; citations: string[] },
  items: PackageItem[],
): Promise<{ result: "ok"; statement: StoredStatement } | { result: "not_found" } | { result: "unknown_citation"; ids: string[] }> {
  const known = new Set(items.map((i) => i.id));
  const unknown = s.citations.filter((id) => !known.has(id));
  if (unknown.length) return { result: "unknown_citation", ids: unknown };
  const citations = [...new Set(s.citations)];
  return inTransaction(pool, async (c) => {
    const v = await c.query("SELECT id FROM release_versions WHERE release_id = $1 AND version_no = $2 FOR UPDATE", [releaseId, versionNo]);
    if (v.rowCount === 0) return { result: "not_found" as const };
    const pos = await c.query("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM statements WHERE version_id = $1 AND audience = $2", [v.rows[0].id, s.audience]);
    const ins = await c.query(
      `INSERT INTO statements (version_id, audience, section, position, text, cited_item_ids, source_hash, edited_by_human)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id, audience, section, position, text, cited_item_ids, source_hash, status, edited_by_human`,
      [v.rows[0].id, s.audience, s.section, pos.rows[0].next, s.text, citations, sourceHashFor(citations, items)],
    );
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'human', 'statement_added', $2)", [
      v.rows[0].id,
      JSON.stringify({ releaseId, versionNo, statementId: ins.rows[0].id, citations }),
    ]);
    return { result: "ok" as const, statement: toStatement(ins.rows[0]) };
  });
}

export interface CarryOverSummary {
  fromVersion: number;
  carried: number;
  fresh: number;
  stale: number;
  sourceRemoved: number;
}

/**
 * Copies the statements of the latest earlier reviewed version onto this version.
 * Statements whose cited items are unchanged keep their status (a human already read that
 * exact content). Statements whose sources changed come across as DRAFT and show as stale.
 * Statements citing items that no longer exist are not copied.
 */
export async function carryOver(pool: pg.Pool, releaseId: number, versionNo: number, items: PackageItem[]): Promise<{ result: "ok"; summary: CarryOverSummary } | { result: "not_found" } | { result: "exists" } | { result: "nothing_to_carry" }> {
  return inTransaction(pool, async (c) => {
    const v = await c.query("SELECT id FROM release_versions WHERE release_id = $1 AND version_no = $2 FOR UPDATE", [releaseId, versionNo]);
    if (v.rowCount === 0) return { result: "not_found" as const };
    const versionId = v.rows[0].id;
    if (((await c.query("SELECT 1 FROM statements WHERE version_id = $1 LIMIT 1", [versionId])).rowCount ?? 0) > 0) return { result: "exists" as const };

    const src = await c.query(
      `SELECT v.id, v.version_no FROM release_versions v
        WHERE v.release_id = $1 AND v.version_no < $2 AND EXISTS (SELECT 1 FROM statements s WHERE s.version_id = v.id)
        ORDER BY v.version_no DESC LIMIT 1`,
      [releaseId, versionNo],
    );
    if (src.rowCount === 0) return { result: "nothing_to_carry" as const };

    const old = await c.query(`SELECT ${STATEMENT_COLUMNS}, s.decided_at FROM statements s WHERE s.version_id = $1 ORDER BY audience, position, id`, [src.rows[0].id]);
    const summary: CarryOverSummary = { fromVersion: src.rows[0].version_no, carried: 0, fresh: 0, stale: 0, sourceRemoved: 0 };
    const toInsert: StatementInsert[] = [];
    for (const row of old.rows) {
      const st = toStatement(row);
      const f = freshness(st.sourceHash, st.citations, items);
      if (f === "source_removed") {
        summary.sourceRemoved++;
        continue;
      }
      const keep = f === "fresh";
      keep ? summary.fresh++ : summary.stale++;
      summary.carried++;
      toInsert.push({
        audience: st.audience,
        section: st.section,
        position: st.position,
        text: st.text,
        citations: st.citations,
        sourceHash: st.sourceHash,
        status: keep ? st.status : "draft",
        editedByHuman: st.editedByHuman,
        decidedAt: keep ? row.decided_at : null,
      });
    }
    await insertStatements(c, versionId, toInsert);
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'system', 'statements_carried_over', $2)", [versionId, JSON.stringify({ releaseId, versionNo, ...summary })]);
    return { result: "ok" as const, summary };
  });
}

export interface BriefRow {
  id: number;
  audience: "internal" | "stakeholder";
  content: string;
  createdAt: string;
}

export async function saveBrief(pool: pg.Pool, releaseId: number, versionNo: number, audience: "internal" | "stakeholder", content: string): Promise<BriefRow | null> {
  return inTransaction(pool, async (c) => {
    const v = await c.query("SELECT id FROM release_versions WHERE release_id = $1 AND version_no = $2", [releaseId, versionNo]);
    if (v.rowCount === 0) return null;
    const b = await c.query("INSERT INTO briefs (version_id, audience, content) VALUES ($1, $2, $3) RETURNING id, audience, content, created_at", [v.rows[0].id, audience, content]);
    await c.query("INSERT INTO audit_log (version_id, actor, action, detail) VALUES ($1, 'human', 'brief_generated', $2)", [v.rows[0].id, JSON.stringify({ releaseId, versionNo, audience, briefId: b.rows[0].id })]);
    return { id: b.rows[0].id, audience: b.rows[0].audience, content: b.rows[0].content, createdAt: new Date(b.rows[0].created_at).toISOString() };
  });
}

export async function listBriefs(pool: pg.Pool, releaseId: number, versionNo: number): Promise<BriefRow[]> {
  const r = await pool.query(
    `SELECT b.id, b.audience, b.content, b.created_at FROM briefs b JOIN release_versions v ON v.id = b.version_id
      WHERE v.release_id = $1 AND v.version_no = $2 ORDER BY b.id DESC`,
    [releaseId, versionNo],
  );
  return r.rows.map((x) => ({ id: x.id, audience: x.audience, content: x.content, createdAt: new Date(x.created_at).toISOString() }));
}
