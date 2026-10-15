import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { testSettings } from "../testing/settings.js";
import { codexStream } from "../testing/codex.js";
import { buildMemoryContext, closeMemoryDatabases, forgetMemory, listMemories, listRecentTurns, recallMemories, rememberExchange, resetUserMemory, sanitizeAssistantTurn } from "./service.js";

test("an exchange from a turn that started before a reset is not stored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-memory-fence-"));
  const previous = { db: process.env.PLANABRAIN_MEMORY_DB_PATH, writer: process.env.PLANABRAIN_MEMORY_WRITER_ENABLED };
  process.env.PLANABRAIN_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");
  process.env.PLANABRAIN_MEMORY_WRITER_ENABLED = "0";
  try {
    const settings = testSettings({ ollamaWebSearchEnabled: false });
    const turnStartedAt = Date.now() - 1000;
    resetUserMemory("fence");
    const stale = await rememberExchange({ userId: "fence", chatId: "chat_f", conversationId: "chat_f", userText: "질문", assistantText: "답", turnStartedAt }, { settings, background: false });
    assert.deepEqual(stale, { recorded: false, writer: "skipped" });
    assert.deepEqual(listRecentTurns("chat_f", "chat_f"), []);
    const fresh = await rememberExchange({ userId: "fence", chatId: "chat_f", conversationId: "chat_f", userText: "질문", assistantText: "답", turnStartedAt: Date.now() + 1 }, { settings, background: false });
    assert.equal(fresh.recorded, true);
    assert.equal(listRecentTurns("chat_f", "chat_f").length, 2);
  } finally {
    closeMemoryDatabases();
    for (const [key, value] of [["PLANABRAIN_MEMORY_DB_PATH", previous.db], ["PLANABRAIN_MEMORY_WRITER_ENABLED", previous.writer]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("an exchange is stored, distilled into memories and recalled in later turns", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-memory-"));
  const previous = { db: process.env.PLANABRAIN_MEMORY_DB_PATH, decision: process.env.PLANABRAIN_DECISION_PROVIDER };
  process.env.PLANABRAIN_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");
  delete process.env.PLANABRAIN_DECISION_PROVIDER;
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(String(init?.body));
    const content = "{\"operations\":[{\"op\":\"add\",\"kind\":\"relationship\",\"content\":\"사용자는 나비라는 고양이를 키운다\",\"importance\":0.7},{\"op\":\"add\",\"kind\":\"request\",\"content\":\"사용자는 짧은 답을 원한다\",\"importance\":0.9}]}";
    return codexStream(content);
  };
  try {
    const settings = testSettings({ ollamaWebSearchEnabled: false });
    const result = await rememberExchange({
      userId: "u1", chatId: "chat_u1", conversationId: "chat_u1", requestId: "req-1",
      userText: "우리 고양이 나비가 요즘 밥을 안 먹어. 앞으로 짧게 답해줘", assistantText: "확인했습니다.\n출처: https://example.com",
    }, { settings, background: false });
    assert.deepEqual(result, { recorded: true, writer: "done" });
    assert.equal(requests.length, 1);
    assert.match(requests[0] ?? "", /"store":false/u);

    await t.test("replaying the same request does not store twice", async () => {
      const again = await rememberExchange({ userId: "u1", chatId: "chat_u1", conversationId: "chat_u1", requestId: "req-1", userText: "x 반복", assistantText: "y" }, { settings, background: false });
      assert.deepEqual(again, { recorded: false, writer: "skipped" });
      assert.deepEqual(listRecentTurns("chat_u1", "chat_u1").map((turn) => turn.text), ["우리 고양이 나비가 요즘 밥을 안 먹어. 앞으로 짧게 답해줘", "확인했습니다."]);
    });

    await t.test("pinned requests are always recalled and topical memories only when related", () => {
      const recall = recallMemories({ userId: "u1", chatId: "chat_u1", query: "나비 병원 가야 할까?" });
      assert.deepEqual(recall.pinned.map((memory) => memory.content), ["사용자는 짧은 답을 원한다"]);
      const context = buildMemoryContext({ recall, query: "나비 병원 가야 할까?" });
      assert.match(context ?? "", /짧은 답/u);
      assert.match(context ?? "", /나비라는 고양이/u);
      const unrelated = buildMemoryContext({ recall: recallMemories({ userId: "u1", chatId: "chat_u1", query: "주식 전망" }), query: "주식 전망" });
      assert.doesNotMatch(unrelated ?? "", /고양이/u);
    });

    await t.test("direct-chat memories are hidden from group chats", () => {
      assert.deepEqual(listMemories("u1", "chat_-100"), []);
    });

    await t.test("forget and reset remove memories", () => {
      const [first] = listMemories("u1", "chat_u1");
      assert.equal(forgetMemory("u1", "chat_u1", first?.id ?? 0), true);
      assert.equal(listMemories("u1", "chat_u1").length, 1);
      assert.equal(resetUserMemory("u1"), true);
      assert.deepEqual(listMemories("u1", "chat_u1"), []);
    });
  } finally {
    globalThis.fetch = original;
    closeMemoryDatabases();
    if (previous.db === undefined) delete process.env.PLANABRAIN_MEMORY_DB_PATH; else process.env.PLANABRAIN_MEMORY_DB_PATH = previous.db;
    if (previous.decision !== undefined) process.env.PLANABRAIN_DECISION_PROVIDER = previous.decision;
    await rm(dir, { recursive: true, force: true });
  }
});

test("only searched answers to time-sensitive questions are replaced in stored history", () => {
  assert.equal(sanitizeAssistantTurn("오늘 환율 알려줘", "1달러는 1,380원입니다.\n\n출처: [환율](https://example.com/fx)"), "시의성 정보 확인 응답 완료.");
  assert.equal(sanitizeAssistantTurn("뉴스레터 문구 다듬어줘", "이번 달 소식을 전해 드립니다."), "이번 달 소식을 전해 드립니다.");
});
