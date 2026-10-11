-- Statements now carry a section so risks and limitations can be required and displayed separately.
ALTER TABLE statements
  ADD COLUMN section TEXT NOT NULL DEFAULT 'change'
  CHECK (section IN ('change', 'risk', 'limitation', 'migration'));

-- One analysis per version; regenerating replaces it.
ALTER TABLE analyses ADD CONSTRAINT analyses_version_id_key UNIQUE (version_id);
