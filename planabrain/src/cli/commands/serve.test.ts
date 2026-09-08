import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Settings } from "../../config/settings.js";
import { createPlanabrainServer, parseAskInput, parseExchangeInput } from "./serve.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    aiProvider: "openrouter",
    openRouterApiKey: "gateway-key",
    openRouterBaseUrl: "http://gateway.example/v1",
    openRouterWebSearchEnabled: false,
    openRouterWebSearchBackend: "plugin",
    openRouterWebSearchMaxResults: 5,
    openRouterWebSearchMaxTotalResults: 15,
    openRouterWebSearchContextSize: "medium",
    cerebrasWebSearchEnabled: false,
    modelStudioWebSearchEnabled: false,
    ollamaApiKeys: [],
    ollamaWebSearchEnabled: false,
    ollamaWebFetchEnabled: false,
    ollamaWebSearchMaxResults: 3,
    ollamaToolMaxIterations: 4,
    webFetchEnabled: false,
    webFetchTimeoutMs: 1000,
    webFetchMaxBytes: 100000,
    webFetchMaxChars: 12000,
    webFetchMaxTotalChars: 18000,
    chatModel: "gemini-3.7-flash",
    deliveryRewriteEnabled: false,
    chatThinkingMode: "off",
    indexPath: ".planabrain/index.json",
    systemPrompt: "테스트 시스템",
    personaProfile: "live",
    intimacyEnabled: false,
    continuousChat: false,
    searchQueryRewriteEnabled: false,
    memoryEnabled: false,
    memoryMaxMessages: 0,
    memoryDir: ".planabrain/memory",
    ...overrides,
  } as Settings;
}

const realFetch = globalThis.fetch;

async function withServer(token: string, run: (base: string) => Promise<void>): Promise<void> {
  const server = createPlanabrainServer({ settings: createSettings(), token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function call(base: string, pathName: string, init: RequestInit = {}, token = "secret") {
  return realFetch(`${base}${pathName}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-planabrain-token": token,
      ...(init.headers ?? {}),
    },
  });
}

test("health responds and rejects a wrong token", async () => {
  await withServer("secret", async (base) => {
    const ok = await call(base, "/v1/health");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; version: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");

    const denied = await call(base, "/v1/health", {}, "wrong");
    assert.equal(denied.status, 401);

    const missing = await call(base, "/v1/nope", { method: "POST", body: "{}" });
    assert.equal(missing.status, 404);
  });
});

test("turn-prepare runs the pipeline over http", async () => {
  await withServer("secret", async (base) => {
    const response = await call(base, "/v1/turn-prepare", {
      method: "POST",
      body: JSON.stringify({
        userId: "serve_test_user",
        chatScope: "chat_serve_test",
        question: "10분 타이머 맞춰줘",
        nowMs: 1_788_800_000_000,
        memoryEnabled: false,
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { schedule: { handled: boolean; dueAtMs: number } };
    assert.equal(body.schedule.handled, true);
    assert.equal(body.schedule.dueAtMs, 1_788_800_600_000);
  });
});

test("ask answers through the configured provider and validation errors are structured", async () => {
  await withServer("secret", async (base) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("http://127.0.0.1")) {
        return realFetch(input, init);
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "안녕하세요, 선생님." }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const answered = await call(base, "/v1/ask", {
      method: "POST",
      body: JSON.stringify({ userId: "u1", question: "안녕", memoryEnabled: false }),
    });
    assert.equal(answered.status, 200);
    const body = (await answered.json()) as { answer: string };
    assert.match(body.answer, /안녕하세요/u);

    const invalid = await call(base, "/v1/ask", {
      method: "POST",
      body: JSON.stringify({ userId: "u1" }),
    });
    assert.equal(invalid.status, 500);
    const error = (await invalid.json()) as { error: { message: string } };
    assert.match(error.error.message, /question/u);
  });
});

test("memory-exchange stores a turn in the data root", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "planabrain-serve-"));
  const previous = process.env.PLANABRAIN_DATA_DIR;
  process.env.PLANABRAIN_DATA_DIR = dataRoot;
  try {
    await withServer("secret", async (base) => {
      const response = await call(base, "/v1/memory-exchange", {
        method: "POST",
        body: JSON.stringify({
          userId: "serve_test_user",
          chatScope: "chat_serve_test",
          userText: "안녕",
          assistantText: "안녕하세요, 선생님.",
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.PLANABRAIN_DATA_DIR;
    } else {
      process.env.PLANABRAIN_DATA_DIR = previous;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("request parsers validate required fields", () => {
  assert.throws(() => parseAskInput(JSON.stringify({ userId: "u" })), /question/u);
  assert.throws(() => parseAskInput("nope"), /JSON/u);
  const ask = parseAskInput(JSON.stringify({ userId: "u", question: "q", image: { path: "/tmp/x.png" } }));
  assert.deepEqual(ask.image, { path: "/tmp/x.png", mimeType: undefined });
  const exchange = parseExchangeInput(
    JSON.stringify({ userId: "u", chatScope: "c", userText: "a", assistantText: "b" }),
  );
  assert.equal(exchange.chatId, "c");
  assert.throws(
    () => parseExchangeInput(JSON.stringify({ userId: "u", chatScope: "c", userText: "a" })),
    /assistantText/u,
  );
});
