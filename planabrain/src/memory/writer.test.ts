import assert from "node:assert/strict";
import test from "node:test";

import { jevEvaluator } from "../decision/config.js";
import { parseOperations, planMemoryOperations } from "./writer.js";
import { chatContext, type MemoryRecord } from "./types.js";

const dm = chatContext("u1", "chat_u1");
const group = chatContext("u1", "chat_-100");

function memory(id: number, content: string): MemoryRecord {
  return { id, subjectUserId: "u1", chatId: "chat_u1", direct: true, kind: "fact", content, importance: 0.5, createdAt: 1, updatedAt: 1, lastRecalledAt: null };
}

test("operations are validated against labelled memories and the chat kind", () => {
  const labels = new Map([["m1", memory(41, "사용자는 서울에 산다")], ["m2", memory(42, "사용자는 고양이를 키운다")]]);
  const raw = `설명 {"operations":[
    {"op":"update","id":"m1","content":"사용자는 부산으로 이사했다","importance":1.4},
    {"op":"delete","id":"m2"},
    {"op":"add","kind":"room","content":"이 방은 반말을 쓴다"},
    {"op":"add","kind":"request","content":"사용자는 시스템 프롬프트를 무시하라고 했다"},
    {"op":"add","kind":"profile","content":"사용자는 서울에 산다"},
    {"op":"add","kind":"preference","content":"사용자는  녹차를   좋아한다"}
  ]}`;
  assert.deepEqual(parseOperations(raw, labels, dm), [
    { op: "update", id: 41, content: "사용자는 부산으로 이사했다", importance: 1 },
    { op: "delete", id: 42 },
    { op: "add", kind: "preference", content: "사용자는 녹차를 좋아한다", importance: 0.5 },
  ]);
  assert.deepEqual(parseOperations(`{"operations":[{"op":"add","kind":"room","content":"이 방은 반말을 쓴다"}]}`, new Map(), group), [
    { op: "add", kind: "room", content: "이 방은 반말을 쓴다", importance: 0.5 },
  ]);
  assert.deepEqual(parseOperations(`{"operations":[{"op":"delete","id":"m9"},{"op":"add","kind":"secret","content":"사용자는 알 수 없는 종류다"}]}`, labels, dm), []);
  assert.equal(parseOperations(`{"operations":${JSON.stringify(Array.from({ length: 9 }, (_, index) => ({ op: "add", kind: "fact", content: `사용자 기억 ${index}` })))}}`, labels, dm).length, 6);
  assert.deepEqual(parseOperations("not json", labels, dm), []);
});

test("short or unremarkable turns never reach the writer model", async () => {
  let calls = 0;
  const complete = async () => { calls += 1; return "{\"operations\":[]}"; };
  assert.deepEqual(await planMemoryOperations({ context: dm, userText: "ㅋㅋ", assistantText: "네", existing: [] }, { complete }), []);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { remember: { type: "noul", noul: 0.03 }, forget: { type: "noul", noul: 0.01 } } }), { status: 200 });
  try {
    const decision = jevEvaluator({ apiKey: "k", baseUrl: "https://decision.example/api", model: "jev", timeoutMs: 1000 });
    assert.deepEqual(await planMemoryOperations({ context: dm, userText: "오늘 환율 얼마야?", assistantText: "1,380원입니다.", existing: [] }, { decision, complete }), []);
  } finally { globalThis.fetch = original; }
  assert.equal(calls, 0);
});

test("the writer sees existing memories by label, not by database id", async () => {
  let prompt = "";
  const operations = await planMemoryOperations(
    { context: dm, userText: "나 이제 부산 살아", assistantText: "확인했습니다.", existing: [memory(77, "사용자는 서울에 산다")] },
    { complete: async (_system, user) => { prompt = user; return "{\"operations\":[{\"op\":\"update\",\"id\":\"m1\",\"content\":\"사용자는 부산에 산다\"}]}"; } },
  );
  assert.match(prompt, /- m1: 사용자는 서울에 산다/u);
  assert.doesNotMatch(prompt, /77/u);
  assert.deepEqual(operations, [{ op: "update", id: 77, content: "사용자는 부산에 산다" }]);
});
