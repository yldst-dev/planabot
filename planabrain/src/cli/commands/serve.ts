import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Settings } from "../../config/settings.js";
import { toStructuredError } from "../../integrations/providerError.js";
import { normalizeWireMessages } from "../../memoryflow/state-normalize.js";
import type { RecentTurnInput } from "../../chat/webSearchAnswer.js";
import { runAsk, type AskInput } from "./ask.js";
import { rememberExchangeTurn } from "./memory.js";
import { buildTurnPrepareDeps, parseTurnPrepareInput, prepareTurn } from "./turn.js";
import type { CommandContext } from "../registry.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TOKEN_HEADER = "x-planabrain-token";

export type ServerOptions = {
  settings: Settings;
  token: string;
};

export function createPlanabrainServer(options: ServerOptions): http.Server {
  const startedAt = Date.now();
  const version = readPackageVersion();
  return http.createServer((request, response) => {
    handleRequest(request, response, options, startedAt, version).catch((error) => {
      writeJson(response, 500, { error: toStructuredError(error) });
    });
  });
}

export async function runServeCommand(_args: string[], context: CommandContext): Promise<void> {
  const settings = context.loadSettings();
  const token = process.env.PLANABRAIN_SERVER_TOKEN?.trim() ?? "";
  const requestedPort = Number.parseInt(process.env.PLANABRAIN_SERVER_PORT ?? "0", 10) || 0;
  const server = createPlanabrainServer({ settings, token });
  const port = await listen(server, requestedPort);
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise<void>(() => {});
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        reject(new Error("서버 주소를 확인하지 못했습니다"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ServerOptions,
  startedAt: number,
  version: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (options.token && request.headers[TOKEN_HEADER] !== options.token) {
    writeJson(response, 401, { error: { kind: "auth_failed", message: "토큰이 올바르지 않습니다" } });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/health") {
    writeJson(response, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version,
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 404, { error: { kind: "unknown", message: "지원하지 않는 경로입니다" } });
    return;
  }

  const raw = await readBody(request);
  switch (url.pathname) {
    case "/v1/turn-prepare": {
      const input = parseTurnPrepareInput(raw);
      const output = await prepareTurn(input, buildTurnPrepareDeps(input.nowMs));
      writeJson(response, 200, output);
      return;
    }
    case "/v1/ask": {
      const input = parseAskInput(raw);
      const result = await runAsk(input, options.settings);
      writeJson(response, 200, { answer: result.answer, transcript: result.transcript ?? null });
      return;
    }
    case "/v1/memory-exchange": {
      const input = parseExchangeInput(raw);
      const result = await rememberExchangeTurn(input);
      writeJson(response, 200, { ok: true, result });
      return;
    }
    default:
      writeJson(response, 404, { error: { kind: "unknown", message: "지원하지 않는 경로입니다" } });
  }
}

export function parseAskInput(raw: string): AskInput {
  const record = parseObject(raw);
  const question = readRequiredString(record.question, "question");
  const userId = readRequiredString(record.userId, "userId");
  const image = parseImage(record.image);
  return {
    question,
    userId,
    currentTurnText: readOptionalString(record.currentTurnText),
    memoryContext: readOptionalString(record.memoryContext),
    image,
    memoryEnabled: typeof record.memoryEnabled === "boolean" ? record.memoryEnabled : undefined,
    recentTurns: parseRecentTurns(record.recentTurns),
    continuousChat: typeof record.continuousChat === "boolean" ? record.continuousChat : undefined,
  };
}

function parseRecentTurns(value: unknown): RecentTurnInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const turns: RecentTurnInput[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const role = record.role === "assistant" ? "assistant" : record.role === "user" ? "user" : null;
    const text = typeof record.text === "string" ? record.text : null;
    if (!role || text === null) {
      continue;
    }
    const wireMessages = normalizeWireMessages(record.wireMessages);
    const epoch =
      typeof record.epoch === "number" && Number.isFinite(record.epoch) ? record.epoch : undefined;
    turns.push({
      role,
      text,
      ...(typeof record.at === "number" ? { at: record.at } : {}),
      ...(wireMessages ? { wireMessages } : {}),
      ...(epoch !== undefined ? { epoch } : {}),
    });
  }
  return turns;
}

export function parseExchangeInput(raw: string): {
  userId: string;
  chatId: string;
  conversationId?: string;
  userText: string;
  assistantText: string;
  wireMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  epoch?: number;
} {
  const record = parseObject(raw);
  const wireMessages = normalizeWireMessages(record.wireMessages);
  const epoch =
    typeof record.epoch === "number" && Number.isFinite(record.epoch) && record.epoch >= 0
      ? record.epoch
      : undefined;
  return {
    userId: readRequiredString(record.userId, "userId"),
    chatId: readRequiredString(record.chatScope ?? record.chatId, "chatScope"),
    conversationId: readOptionalString(record.conversationId),
    userText: readRequiredString(record.userText, "userText"),
    assistantText: readRequiredString(record.assistantText, "assistantText"),
    ...(wireMessages ? { wireMessages } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
  };
}

function parseImage(value: unknown): AskInput["image"] {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const path = readOptionalString(record.path);
  if (!path) {
    return undefined;
  }
  return { path, mimeType: readOptionalString(record.mimeType) };
}

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("요청 본문은 JSON이어야 합니다");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("요청 본문은 JSON 객체여야 합니다");
  }
  return parsed as Record<string, unknown>;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`요청에 ${field}가 필요합니다`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("요청 본문이 너무 큽니다"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
