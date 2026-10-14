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
    turns: [{ role: "user", text: `질문 ${requestId}`, at, ownerUserId: "u1" }, { role: "assistant", text: `답 ${requestId}`, at: at + 1, ownerUserId: "u1", wireMessages: [{ role: "assistant", content: "원문" }], epoch: 2 }],
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

test("a direct-chat edit of a group memory moves it out of the group", () => {
  const database = seed();
  const shared = database.listVisibleMemories(dm).find((memory) => memory.content.includes("매운"));
  database.applyOperations({ context: dm, operations: [{ op: "update", id: shared?.id ?? 0, content: "사용자는 위염 때문에 매운 음식을 못 먹는다" }], startedAt: Date.now(), maxMemoriesPerUser: 200 });
  assert.deepEqual(database.listVisibleMemories(group).map((memory) => memory.content), ["이 방은 금요일마다 회의한다"]);
  assert.ok(database.listVisibleMemories(dm).some((memory) => memory.content.includes("위염")));
  database.close();
});

test("room memories are capped per chat", () => {
  const database = new MemoryDatabase(":memory:");
  database.applyOperations({ context: group, operations: [0.2, 0.9, 0.5].map((importance) => ({ op: "add" as const, kind: "room" as const, content: `이 방은 규칙 ${importance}을 정했다`, importance })), startedAt: Date.now(), maxMemoriesPerUser: 2 });
  assert.deepEqual(database.listVisibleMemories(stranger).map((memory) => memory.importance).sort(), [0.5, 0.9]);
  database.close();
});

test("old turns expire in every conversation and a reset keeps other people's turns", () => {
  const database = new MemoryDatabase(":memory:");
  const now = Date.now();
  const record = (conversationId: string, userId: string, text: string, at: number, cutoffAt: number, replyOwner?: string) => database.recordExchange({
    chatId: "chat_-100", conversationId, maxTurns: 24, cutoffAt,
    turns: [{ role: "user", text, at, ownerUserId: userId }, { role: "assistant", text: `답 ${text}`, at: at + 1, ...(replyOwner ? { ownerUserId: replyOwner } : {}) }],
  });
  record("idle", "u3", "오래된 질문", now - 20_000, 0, "u3");
  record("shared", "u2", "B 질문", now, now - 10_000, "u2");
  assert.deepEqual(database.listConversationTurns("chat_-100", "idle", 0), []);
  record("shared", "u1", "A 질문", now + 10, now - 10_000);
  record("shared", "u2", "B 두 번째", now + 20, now - 10_000, "u2");
  assert.equal(database.resetUser("u1"), true);
  assert.deepEqual(database.listConversationTurns("chat_-100", "shared", 0).map((turn) => turn.text), ["B 질문", "답 B 질문", "B 두 번째", "답 B 두 번째"]);
  database.close();
});
