# agent.md

Guidance for AI coding agents (and humans) working in this repository.

## What this project is

Release Brief Assistant: a developer submits a structured release package; the app checks it deterministically, has an LLM draft evidence-cited summaries for two audiences, and a human reviews every statement before a final brief is produced. **The AI drafts; a human approves. Nothing in this tool approves or deploys a release.**

## Commands

```bash
npm install
npm run migrate           # apply server/migrations/*.sql (needs DATABASE_URL in .env)
npm run dev:server        # API on :3001
npm run dev:web           # UI on :5173
npm test                  # server tests; database tests are skipped without TEST_DATABASE_URL
TEST_DATABASE_URL="<direct postgres url>" npm test    # include database integration tests
npm test -w web           # UI tests
npm run typecheck && npm run build
npm run smoke:llm         # run the real AI pipeline once against the provider in .env
```

Run `npm run typecheck` and the tests before declaring any change done.

## Where things live

- `server/src/schema.ts` package schema and stable item ids (F-, B-, C-, Q-, L-, M-)
- `server/src/checks.ts` deterministic readiness checks (no AI)
- `server/src/items.ts`, `hash.ts` content hashing and staleness (`sourceHashFor`, `freshness`)
- `server/src/diff.ts` version comparison; `brief.ts` final brief assembly and its refusal rules
- `server/src/repo.ts` all SQL; `routes/releases.ts` HTTP layer; `migrate.ts` migration runner
- `server/src/llm/` provider interface, prompts, validators, pipeline, providers (mock, gemini, anthropic)
- `web/src/components/` the UI; `web/src/api.ts` the typed API client

## Rules for changes

**Product guardrails (do not weaken):**
1. The AI never approves anything. Generated statements are saved as `draft`; approval is a human-only endpoint and is audit-logged.
2. Every statement must cite at least one item that exists. Uncited statements are rejected in code and by a database constraint.
3. Unsupported claims found by deterministic checks cannot be removed by model output.
4. Model output is never trusted: parse it, validate it, retry once with the concrete problems, then fail loudly (HTTP 502) and store nothing.
5. The final brief is refused unless nothing is draft, nothing is stale, and every release item, limitation and flagged item is covered by an approved statement.

**Code conventions:**
- TypeScript strict. In `server/`, relative imports use the `.js` extension (ESM).
- No ORM. SQL lives in `repo.ts`. Avoid one-query-per-row loops; a test fails if round trips grow with statement count.
- Migrations are append-only: never edit an applied migration, add a new numbered file.
- Versions are immutable: only insert into `release_versions`.
- Changing what a statement depends on means changing `sourceHashFor`; it affects staleness for existing data, so say so in the commit message.
- Errors return JSON with a stable `error` code; log one JSON line per event with `logger`.

**Testing conventions:**
- Database tests run in a throwaway schema via `server/test/db.ts` and need a **direct** Postgres URL. A pooled URL (for example Neon `-pooler`) is refused, because poolers do not preserve per-connection settings.
- Prefer real Postgres over mocks for repo and route behaviour. Mock only the LLM (`MockProvider`) and `fetch` in provider tests.
- When fixing a bug, add a test that fails without the fix. Key guarantees were verified by deliberately breaking them.

**Security:** never commit `.env`, API keys or database URLs. Only variable names belong in `.env.example` and docs.

## What to be careful about

- The mock provider proves plumbing only. Output quality must be checked with a real model through `npm run smoke:llm`.
- Model names are retired over time. A 404 from the provider usually means setting `GEMINI_MODEL` / `ANTHROPIC_MODEL`.
- Remote databases are slow (100ms+ per round trip); that is why test timeouts are generous.

## How AI was used to build this

This project was built with AI coding assistance (Claude), working in a sandbox and in GitHub Codespaces. Practices that kept it honest:

- Code was verified by running it: unit tests, integration tests against real PostgreSQL, a build, and an end-to-end test driving the real UI against the real server.
- Important guarantees were checked by breaking them on purpose and confirming a test fails.
- Problems found only by running in a real environment were fixed and covered by tests: slow remote-database timeouts, a pooled-connection string breaking test isolation, a retired Gemini model name, and a gap where a feature added in a later version could not be covered by a statement.
- Claims about the AI feature are limited to what was observed: the real-model run in the README shows what one provider produced on one sample.
- The developer remains responsible for everything submitted and is expected to be able to explain any part of it.