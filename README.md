# Release Brief Assistant

Work in progress. Architecture, AI workflow and deployment notes will be added as the app is built.

## Setup

```bash
cp .env.example .env     # set DATABASE_URL
npm install
npm run migrate          # applies server/migrations/*.sql
npm run dev:server       # http://localhost:3001
npm run dev:web          # http://localhost:5173 (proxies /api to the server)
npm test
```

`LLM_PROVIDER=mock` (default) needs no API key.
