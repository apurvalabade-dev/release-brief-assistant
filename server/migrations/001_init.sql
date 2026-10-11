CREATE TABLE releases (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable: an edit to a package inserts a new row, never updates one.
CREATE TABLE release_versions (
  id            SERIAL PRIMARY KEY,
  release_id    INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  version_no    INTEGER NOT NULL,
  package       JSONB NOT NULL,          -- normalized package (every item has an id)
  package_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (release_id, version_no)
);

CREATE TABLE analyses (
  id                 SERIAL PRIMARY KEY,
  version_id         INTEGER NOT NULL REFERENCES release_versions(id) ON DELETE CASCADE,
  deterministic      JSONB NOT NULL,     -- findings from runDeterministicChecks
  classifications    JSONB,              -- LLM: item id -> impact class
  gaps               JSONB,              -- LLM: missing information
  unsupported_claims JSONB,              -- LLM: claims not backed by QA evidence
  model              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE statements (
  id              SERIAL PRIMARY KEY,
  version_id      INTEGER NOT NULL REFERENCES release_versions(id) ON DELETE CASCADE,
  audience        TEXT NOT NULL CHECK (audience IN ('internal', 'stakeholder')),
  position        INTEGER NOT NULL,
  text            TEXT NOT NULL,
  cited_item_ids  TEXT[] NOT NULL,
  source_hash     TEXT NOT NULL,         -- hash of the cited items' content at generation time
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  edited_by_human BOOLEAN NOT NULL DEFAULT false,
  decided_at      TIMESTAMPTZ,
  CHECK (cardinality(cited_item_ids) >= 1)  -- no uncited statements, ever
);

CREATE TABLE briefs (
  id          SERIAL PRIMARY KEY,
  version_id  INTEGER NOT NULL REFERENCES release_versions(id) ON DELETE CASCADE,
  audience    TEXT NOT NULL CHECK (audience IN ('internal', 'stakeholder')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          SERIAL PRIMARY KEY,
  version_id  INTEGER REFERENCES release_versions(id) ON DELETE SET NULL,
  actor       TEXT NOT NULL,             -- 'human' or 'system'; the AI is never an approver
  action      TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
