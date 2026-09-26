import assert from "node:assert/strict";
import test from "node:test";

import { MemoryDatabase } from "./database.js";
import { chatContext } from "./types.js";

const dm = chatContext("u1", "chat_u1");
const group = chatContext("u1", "chat_-100");
const otherGroup = chatContext("u1", "chat_-200");
const stranger = chatContext("u2", "chat_-100");

function seed(): MemoryDatabase {
  const database = new MemoryDatabase(":memory:");
  database.applyOperations({ context: dm, operations: [{ op: "add", kind: "fact", content: "사용자는 병원에 다닌다", importance: 0.9 }], startedAt: Date.now(), maxMemoriesPerUser: 200 });
  database.applyOperations({ context: group, operations: [
    { op: "add", kind: "preference", content: "사용자는 매운 음식을 못 먹는다", importance: 0.7 },
    { op: "add", kind: "room", content: "이 방은 금요일마다 회의한다", importance: 0.6 },
  ], startedAt: Date.now(), maxMemoriesPerUser: 200 });
  return database;
}

test("direct-chat memories stay in the direct chat while group memories follow the user to it", () => {
  const database = seed();
  assert.deepEqual(database.listVisibleMemories(dm).map((memory) => memory.content).sort(), ["사용자는 매운 음식을 못 먹는다", "사용자는 병원에 다닌다"]);
  assert.deepEqual(database.listVisibleMemories(group).map((memory) => memory.content).sort(), ["사용자는 매운 음식을 못 먹는다", "이 방은 금요일마다 회의한다"]);
  assert.deepEqual(database.listVisibleMemories(otherGroup), []);
  assert.deepEqual(database.listVisibleMemories(stranger).map((memory) => memory.kind), ["room"]);
  database.close();
});

test("operations only touch memories visible in the current chat", () => {
  const database = seed();
  const privateId = database.listVisibleMemories(dm).find((memory) => memory.content.includes("병원"))?.id ?? 0;
  assert.equal(database.forget(group, privateId), false);
  assert.equal(database.applyOperations({ context: stranger, operations: [{ op: "update", id: privateId, content: "변조" }], startedAt: Date.now(), maxMemoriesPerUser: 200 }), 0);
  assert.equal(database.forget(dm, privateId), true);
  database.close();
});

test("writes that started before a reset are discarded", () => {
  const database = seed();
  const startedAt = Date.now() - 1000;
  assert.equal(database.resetUser("u1"), true);
  assert.equal(database.applyOperations({ context: dm, operations: [{ op: "add", kind: "fact", content: "사용자는 늦게 저장된 기억이다", importance: 0.5 }], startedAt, maxMemoriesPerUser: 200 }), 0);
  assert.deepEqual(database.listVisibleMemories(dm), []);
  assert.equal(database.listVisibleMemories(stranger).length, 1);
  database.close();
});

test("a full reset also discards writes that were already in flight", () => {
  const database = seed();
  const startedAt = Date.now() - 1000;
  assert.equal(database.resetAll(), true);
  assert.equal(database.applyOperations({ context: group, operations: [{ op: "add", kind: "room", content: "이 방은 늦게 저장된 규칙이다", importance: 0.5 }], startedAt, maxMemoriesPerUser: 200 }), 0);
  assert.equal(database.applyOperations({ context: group, operations: [{ op: "add", kind: "room", content: "이 방은 새 규칙을 정했다", importance: 0.5 }], startedAt: Date.now() + 1, maxMemoriesPerUser: 200 }), 1);
  database.close();
});

test("per-user cap keeps the most important memories", () => {
  const database = new MemoryDatabase(":memory:");
  database.applyOperations({ context: dm, operations: [0.2, 0.9, 0.5].map((importance) => ({ op: "add" as const, kind: "fact" as const, content: `사용자 기억 ${importance}`, importance })), startedAt: Date.now(), maxMemoriesPerUser: 2 });
  assert.deepEqual(database.listVisibleMemories(dm).map((memory) => memory.importance).sort(), [0.5, 0.9]);
  database.close();
});

test("conversation turns are deduplicated by request and trimmed", () => {
  const database = new MemoryDatabase(":memory:");
  const now = Date.now();
  const record = (requestId: string, at: number) => database.recordExchange({
    requestId, chatId: "chat_u1", conversationId: "chat_u1", maxTurns: 3, cutoffAt: now - 10_000,
    turns: [{ role: "user", text: `질문 ${requestId}`, at, ownerUserId: "u1" }, { role: "assistant", text: `답 ${requestId}`, at: at + 1, wireMessages: [{ role: "assistant", content: "원문" }], epoch: 2 }],
  });
  assert.equal(record("a", now), true);
  assert.equal(record("a", now), false);
  assert.equal(record("b", now + 10), true);
  const turns = database.listConversationTurns("chat_u1", "chat_u1", now - 10_000);
  assert.deepEqual(turns.map((turn) => turn.text), ["답 a", "질문 b", "답 b"]);
  assert.deepEqual(turns.at(-1)?.wireMessages, [{ role: "assistant", content: "원문" }]);
  assert.equal(turns.at(-1)?.epoch, 2);
  assert.equal(database.resetUser("u1"), true);
  assert.deepEqual(database.listConversationTurns("chat_u1", "chat_u1", 0), []);
  database.close();
});
