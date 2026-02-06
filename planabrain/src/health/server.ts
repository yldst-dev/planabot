import express, { Request, Response } from "express";

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
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

export function startHealthServer(): void {
  app.listen(PORT, () => {
    console.log(`Brain 헬스체크 서버 시작: 포트 ${PORT}`);
  });
}
