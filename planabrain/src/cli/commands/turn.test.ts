import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentExecution } from "../../runtime/execution.js";
import type { TurnRoute } from "../../decision/turnSignals.js";
import type { MemoryRecord } from "../../memory/types.js";

import {
  parseTurnPrepareInput,
  prepareTurn,
  type TurnPrepareDeps,
} from "../../application/prepareTurn.js";

function deps(overrides: Partial<TurnPrepareDeps> = {}): TurnPrepareDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    classifyTurn: async () => undefined,
    interpretTodo: async () => {
      calls.push("todo");
      return { handled: false };
    },
    interpretSchedule: () => {
      calls.push("schedule");
      return { handled: false };
    },
    listTodos: async () => {
      calls.push("list");
      return { items: [{ id: 1 }], context: "- 할 일" };
    },
    recallMemory: async () => {
      calls.push("recall");
      return { pinned: [], candidates: [memory(7, "사용자는 매운 음식을 못 먹는다")] };
    },
    renderMemory: async () => {
      calls.push("memory");
      return "memory_context:\n- 기억";
    },
    listRecentTurns: async () => {
      calls.push("turns");
      return [
        { role: "user", text: "이전 질문", at: 1 },
        { role: "assistant", text: "이전 답", at: 2, epoch: 0 },
      ];
    },
    ...overrides,
  };
}

function memory(id: number, content: string): MemoryRecord {
  return { id, subjectUserId: "u1", chatId: "chat_1", direct: false, kind: "preference", content, importance: 0.8, createdAt: 1, updatedAt: 1, lastRecalledAt: null };
}

const input = {
  userId: "u1",
  chatScope: "chat_1",
  question: "오늘 할 일 추가해줘",
  memoryQueryText: "오늘 할 일 추가해줘",
};

test("handled todo stops the pipeline early", async () => {
  const d = deps({ interpretTodo: async () => ({ handled: true, message: "추가 완료" }) });
  const out = await prepareTurn(input, d);
  assert.equal(out.todo?.handled, true);
  assert.equal(out.schedule, null);
  assert.equal(out.memoryContext, null);
  assert.deepEqual(d.calls, ["recall"]);
});

test("handled schedule stops before todo list and memory", async () => {
  const d = deps({ interpretSchedule: () => ({ handled: true, action: "list" }) });
  const out = await prepareTurn(input, d);
  assert.equal(out.todo?.handled, false);
  assert.equal(out.schedule?.handled, true);
  assert.equal(out.todoList, null);
  assert.deepEqual(d.calls, ["recall", "todo"]);
});

function signals(route: TurnRoute): TurnPrepareDeps["classifyTurn"] {
  return async () => ({ signals: { route, routeConfident: true, currentInfo: false, searchFollowUp: false, socialOnly: false }, relevantMemoryIds: new Set<number>() });
}

test("confident chat route skips todo and schedule interpreters", async () => {
  const d = deps({ classifyTurn: signals("chat") });
  const out = await prepareTurn({ ...input, question: "어제 헬스장에서 운동했어" }, d);
  assert.deepEqual(d.calls, ["recall", "list", "memory"]);
  assert.equal(out.todo, null);
  assert.equal(out.signals?.route, "chat");
});

test("confident todo route passes the decided action to the interpreter", async () => {
  let received: string | undefined;
  const d = deps({
    classifyTurn: signals("todo_complete"),
    interpretTodo: async (_userId, _text, action) => {
      received = action;
      return { handled: true };
    },
  });
  await prepareTurn(input, d);
  assert.equal(received, "complete");
});

test("confident schedule route skips the todo interpreter", async () => {
  const d = deps({ classifyTurn: signals("schedule_add") });
  await prepareTurn(input, d);
  assert.deepEqual(d.calls, ["recall", "schedule", "list", "memory"]);
});

test("low confidence route falls back to rule interpreters", async () => {
  const d = deps({ classifyTurn: async () => ({ signals: { route: "chat", routeConfident: false, currentInfo: false, searchFollowUp: false, socialOnly: false }, relevantMemoryIds: new Set<number>() }) });
  await prepareTurn(input, d);
  assert.deepEqual(d.calls, ["recall", "todo", "schedule", "list", "memory"]);
});

test("classifier receives the previous user message from recent turns", async () => {
  let previous: string | undefined;
  const d = deps({
    classifyTurn: async (params) => {
      previous = params.previousUserMessage;
      return undefined;
    },
  });
  await prepareTurn({ ...input, conversationId: "conv_1" }, d);
  assert.equal(previous, "이전 질문");
});

test("memory candidates are judged in the classifier call and only relevant ones are rendered", async () => {
  let offered: number[] = [];
  let rendered: number[] = [];
  const d = deps({
    classifyTurn: async (params) => {
      offered = (params.memories ?? []).map((item) => item.id);
      return { signals: { route: "chat", routeConfident: true, currentInfo: false, searchFollowUp: false, socialOnly: false }, relevantMemoryIds: new Set([7]) };
    },
    renderMemory: async (params) => {
      rendered = [...(params.relevantIds ?? [])];
      return "memory";
    },
  });
  await prepareTurn({ ...input, question: "떡볶이 어때?", memoryQueryText: "떡볶이 어때?" }, d);
  assert.deepEqual(offered, [7]);
  assert.deepEqual(rendered, [7]);
});

test("recent turns are loaded only for conversations", async () => {
  const d = deps();
  const out = await prepareTurn({ ...input, conversationId: "conv_1" }, d);
  assert.deepEqual(d.calls, ["turns", "recall", "todo", "schedule", "list", "memory"]);
  assert.equal(out.recentTurns.length, 2);
  assert.equal(out.recentTurns[1].epoch, 0);
});

test("plain questions collect todo context and memory", async () => {
  const d = deps();
  const out = await prepareTurn(input, d);
  assert.deepEqual(d.calls, ["recall", "todo", "schedule", "list", "memory"]);
  assert.deepEqual(out.recentTurns, []);
  assert.deepEqual(out.todoList, { items: [{ id: 1 }], context: "- 할 일" });
  assert.equal(out.memoryContext, "memory_context:\n- 기억");
  assert.deepEqual(out.errors, {});
});

test("stage failures are reported without aborting the turn", async () => {
  const d = deps({
    interpretTodo: async () => {
      throw new Error("todo down");
    },
    recallMemory: async () => {
      throw new Error("sqlite locked");
    },
  });
  const out = await prepareTurn(input, d);
  assert.equal(out.todo, null);
  assert.equal(out.errors.todo, "todo down");
  assert.equal(out.errors.memory, "sqlite locked");
  assert.notEqual(out.todoList, null);
});

test("memory is skipped when disabled", async () => {
  const d = deps();
  const out = await prepareTurn({ ...input, memoryEnabled: false }, d);
  assert.equal(out.memoryContext, null);
  assert.deepEqual(d.calls, ["todo", "schedule", "list"]);
});

test("input parsing validates required fields", () => {
  const parsed = parseTurnPrepareInput(
    JSON.stringify({ userId: "u1", chatScope: "chat_1", question: "q", nowMs: 5, tokenBudget: -1 }),
  );
  assert.equal(parsed.nowMs, 5);
  assert.equal(parsed.tokenBudget, undefined);
  assert.throws(() => parseTurnPrepareInput("{}"), /userId/u);
  assert.throws(() => parseTurnPrepareInput("nope"), /JSON/u);
});

test("prepare preserves request metadata and rejects expired work before side effects", async () => {
  const deadlineMs = Date.now() + 60_000;
  const parsed = parseTurnPrepareInput(JSON.stringify({ ...input, requestId: "prepare-test", deadlineMs }));
  const d = deps({ interpretTodo: async () => {
    assert.equal(currentExecution()?.requestId, "prepare-test");
    assert.equal(currentExecution()?.deadlineMs, deadlineMs);
    return { handled: true };
  } });
  await prepareTurn(parsed, d);
  const expired = deps();
  await assert.rejects(prepareTurn({ ...parsed, deadlineMs: 0 }, expired), { name: "TimeoutError" });
  assert.deepEqual(expired.calls, []);
  assert.throws(() => parseTurnPrepareInput(JSON.stringify({ ...input, requestId: "invalid/id" })), /ID/u);
});

test("CLI preparation honors metadata from stdin without environment overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-prepare-"));
  try {
    for (const expired of [false, true]) {
      const body = { ...input, requestId: "cli-prepare-test", deadlineMs: expired ? 0 : Date.now() + 60_000, question: "10분 타이머 맞춰줘", memoryEnabled: false };
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string; }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url)), "turn-prepare"], {
          env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/dev/null", PLANABRAIN_DATA_DIR: dir },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify(body));
      });
      assert.equal(result.status, expired ? 1 : 0, result.stderr);
      const events = result.stderr.split("\n").flatMap((line) => {
        try { return [JSON.parse(line) as { event?: string; requestId?: string; }]; } catch { return []; }
      });
      assert.equal(events.find((event) => event.event === "execution")?.requestId, body.requestId);
      if (!expired) assert.equal(JSON.parse(result.stdout).schedule.handled, true);
      else assert.equal(result.stdout, "");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
