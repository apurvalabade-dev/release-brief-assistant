# Release Brief Assistant

**Live demo:** https://release-brief-assistant-97z4.onrender.com

Turns a structured release package (features, fixes, behaviour changes, QA evidence, limitations, migration notes, affected user groups) into reviewed, evidence-backed release briefs for two audiences: internal technical users and non-technical stakeholders.

The AI drafts. A human decides. Every statement cites the release item or QA evidence behind it, and nothing in this tool approves or deploys a release.

## What it does

- **Package editor** with stable item IDs (`F-1` features, `B-1` fixes, `C-1` behaviour changes, `Q-1` QA evidence, `L-1` limitations, `M-1` migration notes).
- **Deterministic readiness checks** (no AI): missing sections, duplicate IDs, QA that points at unknown items, and release items with no passing QA evidence.
- **AI analysis**: classifies each change as breaking / user visible / internal, lists missing or vague information, and flags claims the QA evidence does not support.
- **Two summaries** (internal, stakeholder) written as separate statements, each with citations.
- **Human review**: edit, approve, reject or reset every statement; write statements by hand for items that have none.
- **Immutable versions**: saving a package always creates a new version. Compare any two versions field by field.
- **Staleness**: when the package changes, statements whose sources changed are marked stale, return to draft, and cannot be approved until a human edits or rejects them.
- **Final brief**: built only from approved statements, only when nothing is pending, stale or uncovered. It states that it is not a deployment approval.
- **Audit log** of every human and system action.

## How a release flows

```
Package (versioned) -> deterministic checks -> AI analysis + drafts -> human review -> final brief
        ^                                                                  |
        +---- edit & save as new version -> carry over -> stale markers ---+
```

## Architecture

| Layer | Tech |
|---|---|
| UI | React, TypeScript, Vite |
| API | Node, Express, Zod validation |
| Data | PostgreSQL (plain SQL migrations) |
| AI | Provider interface: `mock`, `gemini`, `anthropic` |
| Tests | Vitest, Testing Library, Supertest |

Key design decisions:

- **Versions are immutable.** `release_versions` rows are only ever inserted. Concurrent saves lock the release row, so version numbers are distinct and gapless.
- **Staleness is computed, not guessed.** Each statement stores a hash of the items it cites plus the QA evidence attached to them. A new version is compared against that hash. Adding passing QA for a feature makes a "not yet verified" statement stale even though the feature itself did not change.
- **The model is not trusted.** Its output is parsed and validated in code (see below).
- **Round trips are constant.** Statements are inserted with one set-based query, so a 60-statement review costs the same number of queries as a 6-statement one. A test enforces this.

Tables: `releases`, `release_versions`, `analyses`, `statements`, `briefs`, `audit_log`, `schema_migrations`.

## AI workflow and guardrails

The model produces an analysis, then the two audience summaries (generated in parallel). The code around it enforces:

1. Every statement must cite at least one item, and every cited ID must exist.
2. A "limitation" statement must cite a limitation item, and every known limitation must appear in some statement.
3. Every release item the deterministic checks flagged (no QA, or QA not passing) must be cited by a "risk" statement.
4. Unsupported claims found by the checks are always kept; the model can add to them but cannot remove them.
5. Invalid output is retried once with the specific problems fed back to the model. A second failure returns an error (HTTP 502) and stores nothing.
6. Rate limits and transient provider errors (429/5xx) are retried once, honoring `Retry-After`. Auth errors are never retried.
7. Generated statements are saved as **drafts**. There is no code path where the AI sets a statement to approved, and regeneration is refused once a human has reviewed anything for that version.

The prompts instruct the model never to call a change verified without passing QA, never to restate an unverified claim as fact in a change statement, and never to say a release is approved. These are instructions, not guarantees; the checks above are the guarantees.

With a real model, generation takes about a minute.

## API

| Method | Path | Purpose |
|---|---|---|
| POST / GET | `/api/releases` | create / list releases |
| GET | `/api/releases/:id` | release and its versions |
| POST | `/api/releases/:id/versions` | save a new version (no-op if unchanged) |
| GET | `/api/releases/:id/versions/:n` | a version plus readiness checks |
| GET | `/api/releases/:id/diff?from=&to=` | field-level diff between versions |
| POST | `/api/releases/:id/versions/:n/generate` | generate analysis and drafts |
| GET | `/api/releases/:id/versions/:n/review` | analysis and statements with freshness |
| PATCH | `/api/releases/:id/versions/:n/statements/:sid` | edit text / approve / reject / reset |
| POST | `/api/releases/:id/versions/:n/statements` | add a statement by hand |
| POST | `/api/releases/:id/versions/:n/carry-over` | copy statements from the previous version; stale ones become drafts |
| POST / GET | `/api/releases/:id/versions/:n/brief(s)` | build / list final briefs |

## Run locally

Requires Node 20+ and a PostgreSQL database (a free Neon project works).

```bash
cp .env.example .env        # set DATABASE_URL
npm install
npm run migrate
npm run dev:server          # API on :3001
npm run dev:web             # UI on :5173 (proxies /api to the server)
```

`LLM_PROVIDER=mock` (the default) needs no API key and is deterministic. To use a real model, create a free key at https://aistudio.google.com/apikey, then in `.env` set:

```
LLM_PROVIDER=gemini
GEMINI_API_KEY=<your key>
```

`.env` is git-ignored; never commit a key. Check the provider end to end with:

```bash
npm run smoke:llm           # runs the real pipeline once and prints the result
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none | Postgres connection string |
| `PORT` | `3001` | |
| `LLM_PROVIDER` | `mock` | `mock`, `gemini` or `anthropic` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | none / see `.env.example` | model names are retired over time; a 404 means set `GEMINI_MODEL` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | none / see `.env.example` | |
| `LLM_TIMEOUT_MS` | `60000` | per model call |
| `LLM_RETRIES` / `LLM_RETRY_DELAY_MS` | `1` / `2000` | for 429 and 5xx only |

## Tests

```bash
npm test                                   # server: runs without a database, skips DB tests
TEST_DATABASE_URL="<direct postgres url>" npm test   # server including database integration tests
npm test -w web                            # UI component tests
```

- **Server (125 tests):** pure logic (schema, hashing, staleness, checks, diff, brief assembly, validators, prompts, provider HTTP handling, parallel generation) plus database integration tests for the whole review workflow, including concurrent saves and the constant-round-trip guarantee. 93 run without a database; 32 need `TEST_DATABASE_URL`.
- **Database isolation:** each integration run creates a throwaway schema and drops it afterwards. Use a **direct** connection string, not a pooled one (for example not a Neon `-pooler` host). Poolers do not preserve per-connection settings, so the helper refuses them.
- **Timeouts** are generous because a remote database makes each request slow; a full database run can take a few minutes.
- **Web (23 tests):** component tests with a mocked API, plus an opt-in end-to-end test that drives the real UI against a running server (`E2E_API_URL=http://localhost:3001 npm test -w web`).
- Key guarantees were also checked by deliberately breaking them and confirming the tests fail.

## Deployment

One service serves both the API and the built UI (Render + Neon, same region).

| Setting | Value |
|---|---|
| Build command | `npm install --include=dev && npm run build` |
| Start command | `node server/dist/migrate.js && node server/dist/index.js` |
| Health check path | `/api/health` |
| Environment | `NODE_VERSION=22`, `DATABASE_URL`, `LLM_PROVIDER`, `GEMINI_MODEL`, `LLM_TIMEOUT_MS=120000`, and the matching API key |

Migrations run on every start and are a no-op once applied; if one fails the server does not start. Secrets are set in the host's dashboard, never in git. Free tiers sleep when idle, so the first request after a pause can take a while.

## Sample real-model output

`npm run smoke:llm` against `gemini-3.8-flash`, on a sample package whose F-1 description claims the export is "10x faster and fully load-tested" while the only QA evidence is a 100-row smoke test:

```
deterministic checks: ready=true, findings=ITEM_WITHOUT_QA(F-2), ITEM_QA_NOT_PASSING(C-1)

unsupported claims:
  F-2 [deterministic] F-2 "Dark mode" has no QA evidence covering it.
  C-1 [deterministic] C-1 "Session timeout is now 30 minutes" has QA evidence, but none of it passed (Q-3=partial).
  F-1 [model] The description claims the export is '10x faster and fully load-tested for large accounts', but QA evidence Q-1 only covers a smoke test of 100 rows on staging...

internal    [risk] F-1: Claims of being 10x faster and fully load-tested for large accounts are unsupported; test evidence Q-1 only covers a 100-row staging smoke test.  <- F-1, Q-1
stakeholder [risk] Claims regarding ten-fold export speeds and performance under heavy load have not been confirmed, as testing only covered a small sample file.  <- F-1, Q-1

model caught the unsupported "10x faster / fully load-tested" claim on F-1: YES
```

The first two findings come from deterministic checks; the F-1 claim could only be found by the model reading the wording. Every statement cites real items, which the code verifies. This is one run of one model on one sample, not a benchmark.

## Project layout

```
server/src/          schema, checks, items (hashing/staleness), diff, brief, repo (SQL), routes, llm/ (providers, prompts, validators, pipeline)
server/migrations/   plain SQL migrations (append-only)
server/test/         unit and integration tests
web/src/             App, components (Package editor, Review, Compare, Brief), API client, types
agent.md             guidance for AI coding agents and how AI was used to build this
```

## Limitations and next steps

- No authentication or multi-user permissions; every action is recorded as `human`.
- Stale markers appear after "Carry over statements" on the new version, not automatically when the package is saved.
- Statements for items added in a later version are written by hand; there is no "draft only the missing ones" action yet.
- Detection of claims the QA evidence does not support has a deterministic part (no or non-passing QA) and a model part (wording such as "10x faster"). The model part depends on the model's quality; it was observed once end to end with Gemini (see above), not benchmarked.
- A real-model change statement may still echo an unverified claim before its risk statement flags it; the prompt tells the model not to, but only the structural guarantees are enforced in code.
- Package text is sent to the model as data. The validators limit what a manipulated answer can do, but the text itself is not sanitized.
- The UI was tested with jsdom, not across real browsers or screen readers.

## AI-assisted development

This project was built with AI coding assistance (Claude). Its guarantees were verified by running the test suites against a real PostgreSQL database and by breaking them on purpose to confirm tests fail, not by trusting the generated code. See [agent.md](agent.md) for the working rules and what was found and fixed along the way.