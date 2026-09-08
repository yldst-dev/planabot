import { readFileSync } from "node:fs";

import express, { Request, Response } from "express";

export const HEALTH_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const app = express();
const PORT = process.env.BRAIN_HEALTH_PORT || 8081;
const HEALTH_SECRET = process.env.HEALTH_SECRET_BRAIN;
const startTime = Date.now();

app.get("/health", (req: Request, res: Response) => {
  if (HEALTH_SECRET && req.query.secret !== HEALTH_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: HEALTH_VERSION,
    timestamp: new Date().toISOString(),
  });
});

export function startHealthServer(): void {
  app.listen(PORT, () => {
    console.log(`Brain 헬스체크 서버 시작: 포트 ${PORT}`);
  });
}
