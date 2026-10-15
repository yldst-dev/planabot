import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Settings } from "../../config/settings.js";
import { testSettings } from "../../testing/settings.js";
import { codexStream } from "../../testing/codex.js";
import { createPlanabrainServer, parseAskInput, parseExchangeInput } from "./serve.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({ ollamaWebSearchEnabled: false, continuousChat: false, searchQueryRewriteEnabled: false, ...overrides });
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
    const body = (await ok.json()) as { ok: boolean; version: string; };
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
    const body = (await response.json()) as { schedule: { handled: boolean; dueAtMs: number; }; };
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
      return codexStream("안녕하세요, 선생님.");
    }) as typeof fetch;

    const answered = await call(base, "/v1/ask", {
      method: "POST",
      body: JSON.stringify({ userId: "u1", question: "안녕", memoryEnabled: false }),
    });
    assert.equal(answered.status, 200);
    const body = (await answered.json()) as { answer: string; };
    assert.match(body.answer, /안녕하세요/u);

    const invalid = await call(base, "/v1/ask", {
      method: "POST",
      body: JSON.stringify({ userId: "u1" }),
    });
    assert.equal(invalid.status, 400);
    const error = (await invalid.json()) as { error: { message: string; }; };
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
      const body = (await response.json()) as { ok: boolean; };
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
  const longHistory = Array.from({ length: 41 }, (_, index) => ({ role: "user", text: String(index) }));
  const trimmed = parseAskInput(JSON.stringify({ userId: "u", question: "q", recentTurns: longHistory }));
  assert.equal(trimmed.recentTurns?.length, 40);
  assert.equal(trimmed.recentTurns?.[0]?.text, "1");
  const exchange = parseExchangeInput(
    JSON.stringify({ userId: "u", chatScope: "c", userText: "a", assistantText: "b" }),
  );
  assert.equal(exchange.chatId, "c");
  assert.throws(
    () => parseExchangeInput(JSON.stringify({ userId: "u", chatScope: "c", userText: "a" })),
    /assistantText/u,
  );
});

test("disconnecting an ask cancels its provider request", async () => {
  await withServer("secret", async (base) => {
    let started: () => void = () => { };
    let cancelled: () => void = () => { };
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    const upstreamCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
    globalThis.fetch = async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => { cancelled(); reject(init?.signal?.reason); };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const controller = new AbortController();
    const request = call(base, "/v1/ask", { method: "POST", signal: controller.signal, body: JSON.stringify({ userId: "actor", question: "질문", memoryEnabled: false }) });
    const rejected = assert.rejects(request, { name: "AbortError" });
    await upstreamStarted;
    controller.abort();
    await rejected;
    await upstreamCancelled;
  });
});

test("repeated ask IDs reuse a response without another provider call", async () => {
  await withServer("secret", async (base) => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return codexStream("확인했습니다.");
    };
    const body = JSON.stringify({ userId: "actor", question: "질문", requestId: "request-one", memoryEnabled: false });
    const first = await call(base, "/v1/ask", { method: "POST", body });
    const second = await call(base, "/v1/ask", { method: "POST", body });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(calls, 1);
  });
});

test("expired deadlines reject an ask before its provider is contacted", async () => {
  await withServer("secret", async (base) => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("unexpected provider call"); };
    const response = await call(base, "/v1/ask", { method: "POST", body: JSON.stringify({ userId: "actor", question: "질문", deadlineMs: Date.now() - 1 }) });
    assert.equal(response.status, 504);
    assert.equal(calls, 0);
  });
});

test("a provider rate limit is returned as a structured error instead of an answer", async () => {
  await withServer("secret", async (base) => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "0" },
    });
    const response = await call(base, "/v1/ask", { method: "POST", body: JSON.stringify({ userId: "actor", question: "질문" }) });
    const body = (await response.json()) as { answer?: string; error?: { kind: string; }; };
    assert.equal(response.ok, false);
    assert.equal(body.answer, undefined);
    assert.equal(body.error?.kind, "rate_limited");
  });
});

test("oversized bodies get 413 and memory routes stay open while answers are busy", async () => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "planabrain-serve-"));
  const previous = process.env.PLANABRAIN_DATA_DIR;
  process.env.PLANABRAIN_DATA_DIR = dataRoot;
  try {
    await withServer("secret", async (base) => {
      const tooLarge = await call(base, "/v1/memory-list", { method: "POST", body: "x".repeat(4 * 1024 * 1024 + 1) });
      assert.equal(tooLarge.status, 413);
      assert.equal(((await tooLarge.json()) as { error: { kind: string; }; }).error.kind, "invalid_request");

      let started = 0;
      globalThis.fetch = async (_input, init) => {
        started += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      };
      const controller = new AbortController();
      const asks = Array.from({ length: 4 }, (_, index) =>
        call(base, "/v1/ask", { method: "POST", signal: controller.signal, body: JSON.stringify({ userId: `u${index}`, question: "질문" }) }).catch(() => undefined));
      while (started < 4) await new Promise((resolve) => setTimeout(resolve, 10));

      const busy = await call(base, "/v1/ask", { method: "POST", body: JSON.stringify({ userId: "u5", question: "질문" }) });
      assert.equal(busy.status, 503);
      const memories = await call(base, "/v1/memory-list", { method: "POST", body: JSON.stringify({ userId: "u1", chatScope: "chat_1" }) });
      assert.equal(memories.status, 200);
      const anonymous = await call(base, "/v1/memory-list", { method: "POST", body: "{}" }, "wrong");
      assert.equal(anonymous.status, 401);

      controller.abort();
      await Promise.all(asks);
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
