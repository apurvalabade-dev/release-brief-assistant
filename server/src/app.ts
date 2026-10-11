import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => logger.info("request", { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - start }));
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_failed", issues: err.issues });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    logger.error("unhandled error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);

  return app;
}
