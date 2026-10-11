import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { getPool } from "./db.js";
import { createProvider } from "./llm/index.js";
import { logger } from "./logger.js";

const config = loadConfig();
if (!config.DATABASE_URL) logger.warn("DATABASE_URL is not set; /api/releases will return 503");
const app = createApp({ pool: config.DATABASE_URL ? getPool(config.DATABASE_URL) : undefined, provider: createProvider(config) });

// In production the built React app is served by this same server.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(config.PORT, () => logger.info("server listening", { port: config.PORT, llm: config.LLM_PROVIDER }));
