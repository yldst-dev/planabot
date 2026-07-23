import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalMemoryEngine } from "./memory-engine.js";

async function withEngine(
  run: (engine: LocalMemoryEngine) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "planabrain-memory-test-"));
  const engine = new LocalMemoryEngine({
    rootDir,
    sqlitePath: path.join(rootDir, "memory.sqlite"),
    storeKind: "json",
    groupMemoryEnabled: true,
    compactionEnabled: false
  });
  try {
    await run(engine);
  } finally {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("preparePromptInput does not store the current turn", async () => {
  await withEngine(async (engine) => {
    const prepared = await engine.preparePromptInput({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "conversation-1",
      userText: "프라나야 심심해"
    });

    const user = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      scopeKind: "user"
    });
    const conversation = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "conversation-1",
      scopeKind: "conversation"
    });
    const group = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      scopeKind: "group"
    });

    assert.equal(prepared.memoryContext, "memory_context: none");
    assert.equal(user.state.working.turns.length, 0);
    assert.equal(conversation.state.working.turns.length, 0);
    assert.equal(group.state.working.turns.length, 0);
  });
});

test("rememberExchange stores raw working turns only in conversation scope", async () => {
  await withEngine(async (engine) => {
    const now = Date.now();
    await engine.rememberExchange({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "conversation-1",
      userText: "저는 재즈를 좋아합니다",
      assistantText: "확인 완료.",
      at: now
    });

    const user = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      scopeKind: "user"
    });
    const conversation = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "conversation-1",
      scopeKind: "conversation"
    });
    const group = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      scopeKind: "group"
    });

    assert.equal(user.state.working.turns.length, 0);
    assert.equal(user.state.semantic.facts.length, 1);
    assert.deepEqual(
      conversation.state.working.turns.map((turn) => turn.role),
      ["user", "assistant"]
    );
    assert.deepEqual(
      conversation.state.working.turns.map((turn) => turn.at),
      [now, now + 1]
    );
    assert.equal(group.state.working.turns.length, 0);
  });
});

test("independent conversations do not receive raw working turns", async () => {
  await withEngine(async (engine) => {
    const now = Date.now();
    await engine.rememberExchange({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "weather",
      userText: "삿포로 2026년 8월 말 날씨를 알려줘",
      assistantText: "날씨 답변",
      at: now
    });

    const independent = await engine.preparePromptInput({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "bored",
      userText: "심심해"
    });
    const continued = await engine.preparePromptInput({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "weather",
      userText: "삿포로 날씨"
    });

    assert.equal(independent.memoryContext, "memory_context: none");
    assert.match(continued.memoryContext, /삿포로 2026년 8월 말 날씨/u);
  });
});

test("shared group exchanges keep episodic data without raw working turns", async () => {
  await withEngine(async (engine) => {
    const now = Date.now();
    const result = await engine.rememberExchange({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "conversation-1",
      userText: "우리 그룹 회의 일정은 금요일입니다",
      assistantText: "그룹 일정을 정리했습니다",
      at: now
    });
    const group = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      scopeKind: "group"
    });

    assert.equal(result.groupStored, true);
    assert.equal(group.state.working.turns.length, 0);
    assert.ok(group.state.episodic.items.length > 0);
  });
});

test("time-sensitive answers do not persist values or source URLs", async () => {
  await withEngine(async (engine) => {
    await engine.rememberExchange({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "weather",
      userText: "오늘 삿포로 날씨를 알려줘",
      assistantText:
        "현재 기온은 30도입니다.\n\n출처: https://weather.example/current",
      at: Date.now()
    });

    const conversation = await engine.inspectScope({
      userId: "user-1",
      chatId: "chat-1",
      conversationId: "weather",
      scopeKind: "conversation"
    });
    const assistant = conversation.state.working.turns.at(-1);

    assert.equal(assistant?.text, "시의성 정보 확인 응답 완료.");
    assert.doesNotMatch(assistant?.text ?? "", /30도|weather\.example/u);
  });
});
