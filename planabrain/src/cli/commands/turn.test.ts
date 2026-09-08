import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMemoryContext,
  parseTurnPrepareInput,
  prepareTurn,
  type TurnPrepareDeps,
} from "./turn.js";

function deps(overrides: Partial<TurnPrepareDeps> = {}): TurnPrepareDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
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
    prepareMemory: async () => {
      calls.push("memory");
      return "memory_context:\n- 기억";
    },
    ...overrides,
  };
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
  assert.deepEqual(d.calls, []);
});

test("handled schedule stops before todo list and memory", async () => {
  const d = deps({ interpretSchedule: () => ({ handled: true, action: "list" }) });
  const out = await prepareTurn(input, d);
  assert.equal(out.todo?.handled, false);
  assert.equal(out.schedule?.handled, true);
  assert.equal(out.todoList, null);
  assert.deepEqual(d.calls, ["todo"]);
});

test("plain questions collect todo context and memory", async () => {
  const d = deps();
  const out = await prepareTurn(input, d);
  assert.deepEqual(d.calls, ["todo", "schedule", "list", "memory"]);
  assert.deepEqual(out.todoList, { items: [{ id: 1 }], context: "- 할 일" });
  assert.equal(out.memoryContext, "memory_context:\n- 기억");
  assert.deepEqual(out.errors, {});
});

test("stage failures are reported without aborting the turn", async () => {
  const d = deps({
    interpretTodo: async () => {
      throw new Error("todo down");
    },
    prepareMemory: async () => {
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

test("memory context sentinel becomes null", () => {
  assert.equal(normalizeMemoryContext("memory_context: none"), null);
  assert.equal(normalizeMemoryContext("  "), null);
  assert.equal(normalizeMemoryContext("memory_context:\n- a"), "memory_context:\n- a");
});
