import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Settings } from "../../config/settings.js";
import { testSettings } from "../../testing/settings.js";
import { codexStream } from "../../testing/codex.js";
import { runDetached } from "../../runtime/execution.js";
import { createPlanabrainServer, parseAskInput, parseExchangeInput, stopServer } from "./serve.js";
import { runScheduleInterpretCommand } from "./schedule.js";
import { runTodoListCommand } from "./todo.js";
import { addTodo, completeTodo } from "../../todo/store.js";

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

test("a malformed request target gets 400 instead of crashing the server", async () => {
  await withServer("secret", async (base) => {
    const { port } = new URL(base);
    const statusLine = await new Promise<string>((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write("POST //:99999/v1/ask HTTP/1.1\r\nHost: x\r\nx-planabrain-token: secret\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
      });
      let data = "";
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    });
    assert.match(statusLine, / 400 /u);
    assert.equal((await call(base, "/v1/health")).status, 200);
  });
});

test("stopping the server waits for background jobs but not past the grace period", async () => {
  const listening = async () => {
    const server = createPlanabrainServer({ settings: createSettings(), token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  let finished = false;
  void runDetached(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    finished = true;
  });
  await stopServer(await listening(), 5_000);
  assert.equal(finished, true);

  let release: () => void = () => { };
  void runDetached(() => new Promise<void>((resolve) => { release = resolve; }));
  const startedAt = Date.now();
  await stopServer(await listening(), 50);
  assert.ok(Date.now() - startedAt < 1_000);
  release();
});

const MORNING_MS = Date.UTC(2026, 10, 16, 0, 30);
const AFTERNOON_MS = Date.UTC(2026, 10, 16, 6, 0);

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (typeof chunk !== "string") return original(chunk, ...rest);
    written.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return written.join("");
}

async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function stubDecision(seen: string[], delayMs = 0): { maxInFlight: () => number; } {
  let inFlight = 0;
  let max = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/v1/systemone")) return realFetch(input, init);
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight -= 1;
    const body = JSON.parse(String(init?.body)) as { state: { current_time?: string; }; };
    const time = body.state.current_time ?? "";
    seen.push(time);
    const hour = Number(time.slice(11, 13));
    return new Response(JSON.stringify({ answers: { route: { choice: "schedule_add", confidence: 0.9 }, afternoon: hour < 12 ? 0.9 : 0.1 } }), { status: 200 });
  }) as typeof fetch;
  return { maxInFlight: () => max };
}

const DECISION_ENV = { PLANABRAIN_DECISION_PROVIDER: "jev", PLANABRAIN_DECISION_API_KEY: "stub", PLANABRAIN_DECISION_BASE_URL: "http://decision.invalid" };

async function cliSchedule(text: string, nowMs: number): Promise<string> {
  let output = "";
  await withEnv({ PLANABRAIN_NOW_MS: String(nowMs) }, async () => {
    output = await captureStdout(() => runScheduleInterpretCommand([text]));
  });
  return output.trim();
}

async function servedSchedule(base: string, text: string, nowMs: number): Promise<{ status: number; body: string; }> {
  const response = await call(base, "/v1/schedule-interpret", { method: "POST", body: JSON.stringify({ text, nowMs }) });
  return { status: response.status, body: await response.text() };
}

test("schedule-interpret over http prints the same JSON as the CLI command on every pass", async () => {
  const texts = [
    "10분 뒤 알림",
    "내일 오후 3시 회의 알림",
    "3시에 알림 해줘",
    "5시 회의 알려줘",
    "타이머 5분",
    "30초 타이머 맞춰줘",
    "알림 목록",
    "일정 보여줘",
    "회의 알림 취소",
    "알림 전부 삭제",
    "모레 아침 8시 운동 알림",
    "다음주 월요일 10시 알림",
    "1시간 30분 후에 약 먹으라고 알려줘",
    "자정에 알림",
    "'3시' 라는 말은 그냥 해본 거야",
    "  10분 뒤 알림  ",
    `${"가".repeat(700)} 10분 뒤 알림`,
    `${"나".repeat(2500)} 취소`,
  ];
  await withEnv(DECISION_ENV, async () => {
    await withServer("secret", async (base) => {
      const seen: string[] = [];
      stubDecision(seen);
      for (const nowMs of [MORNING_MS, AFTERNOON_MS]) {
        const expected: Array<{ text: string; json: string; }> = [];
        for (const text of texts) expected.push({ text, json: await cliSchedule(text, nowMs) });
        for (let pass = 0; pass < 2; pass += 1) {
          await withEnv({ PLANABRAIN_NOW_MS: String(nowMs + 7 * 86_400_000) }, async () => {
            for (const { text, json } of expected) {
              const served = await servedSchedule(base, text, nowMs);
              assert.equal(served.status, 200, text);
              assert.equal(served.body, json, text);
            }
          });
        }
      }
      assert.ok(seen.length > 0);
      assert.ok(seen.every((time) => time.startsWith("2026-11-16 09:30") || time.startsWith("2026-11-16 15:00")), seen.join(","));
    });
  });
});

test("schedule-interpret reads long text from the CLI text file the same way", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "planabrain-schedule-text-"));
  const text = `${"다".repeat(2100)} 10분 뒤 알림`;
  const file = path.join(dir, "text.txt");
  writeFileSync(file, `${text}\n`);
  try {
    await withServer("secret", async (base) => {
      let fromFile = "";
      await withEnv({ PLANABRAIN_NOW_MS: String(MORNING_MS), PLANABRAIN_SCHEDULE_TEXT_FILE: file }, async () => {
        fromFile = (await captureStdout(() => runScheduleInterpretCommand([]))).trim();
      });
      assert.equal((await servedSchedule(base, text, MORNING_MS)).body, fromFile);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule-interpret rejects empty text like the CLI and validates its body", async () => {
  await assert.rejects(withEnv({ PLANABRAIN_SCHEDULE_TEXT_FILE: "" }, () => runScheduleInterpretCommand(["   "])));
  await withServer("secret", async (base) => {
    for (const body of [{ text: "   ", nowMs: MORNING_MS }, { nowMs: MORNING_MS }, { text: "10분 뒤 알림" }, { text: "10분 뒤 알림", nowMs: -1 }, { text: "10분 뒤 알림", nowMs: "1" }]) {
      const response = await call(base, "/v1/schedule-interpret", { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
      const parsed = (await response.json()) as { error: { kind: string; }; };
      assert.equal(parsed.error.kind, "invalid_request");
    }
    const badId = await call(base, "/v1/schedule-interpret", { method: "POST", body: JSON.stringify({ text: "10분 뒤 알림", nowMs: MORNING_MS, requestId: "a b" }) });
    assert.equal(badId.status, 400);
    const denied = await call(base, "/v1/schedule-interpret", { method: "POST", body: JSON.stringify({ text: "10분 뒤 알림", nowMs: MORNING_MS }) }, "wrong");
    assert.equal(denied.status, 401);
    const denyTodo = await call(base, "/v1/todo-list", { method: "POST", body: JSON.stringify({ userId: "1" }) }, "wrong");
    assert.equal(denyTodo.status, 401);
  });
});

test("simultaneous schedule-interpret requests keep their own clock", async () => {
  await withEnv(DECISION_ENV, async () => {
    await withServer("secret", async (base) => {
      const seen: string[] = [];
      const stub = stubDecision(seen, 50);
      const text = "3시에 알림 해줘";
      const morning = await cliSchedule(text, MORNING_MS);
      const afternoon = await cliSchedule(text, AFTERNOON_MS);
      assert.notEqual(morning, afternoon);
      seen.length = 0;
      const [first, second] = await Promise.all([servedSchedule(base, text, MORNING_MS), servedSchedule(base, text, AFTERNOON_MS)]);
      assert.equal(stub.maxInFlight(), 2);
      assert.deepEqual([...seen].sort(), ["2026-11-16 09:30 KST", "2026-11-16 15:00 KST"]);
      assert.equal(first.body, morning);
      assert.equal(second.body, afternoon);
    });
  });
});

test("todo-list over http prints the same JSON as the CLI command", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "planabrain-todo-route-"));
  try {
    await withEnv({ PLANABRAIN_TODO_DIR: dir }, async () => {
      await addTodo("100", "장보기");
      await addTodo("100", "보고서 \"초안\" <정리>");
      await addTodo("300", "운동");
      await completeTodo("300", "운동");
      await addTodo("../escape", "경로");
      await withServer("secret", async (base) => {
        for (const userId of ["100", "200", "300", "12345678901", "../escape", " 400"]) {
          const cli = (await captureStdout(() => runTodoListCommand([userId]))).trim();
          for (let pass = 0; pass < 2; pass += 1) {
            const response = await call(base, "/v1/todo-list", { method: "POST", body: JSON.stringify({ userId }) });
            assert.equal(response.status, 200, userId);
            assert.equal(await response.text(), cli, userId);
          }
        }
        const missing = await call(base, "/v1/todo-list", { method: "POST", body: JSON.stringify({ userId: " " }) });
        assert.equal(missing.status, 400);
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
