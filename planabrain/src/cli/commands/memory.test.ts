import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeMemoryDatabases, listMemories, listRecentTurns } from "../../memory/service.js";
import { codexStream } from "../../testing/codex.js";
import { testSettings } from "../../testing/settings.js";
import { runMemoryExchangeCommand } from "./memory.js";

const KEYS = ["PLANABRAIN_MEMORY_DB_PATH", "PLANABRAIN_DECISION_PROVIDER", "PLANABRAIN_TURN_STARTED_AT", "PLANABRAIN_CONVERSATION_ID", "PLANABRAIN_TRANSCRIPT_JSON", "PLANABRAIN_TRANSCRIPT_JSON_FILE"] as const;

async function runStep(step: string, args: string[]): Promise<unknown> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runMemoryExchangeCommand([`--step=${step}`, ...args], testSettings({ ollamaWebSearchEnabled: false }));
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(written.join("").trim());
}

test("an unknown memory exchange step is rejected", async () => {
  await assert.rejects(runMemoryExchangeCommand(["--step=later", "u", "chat_u", "q", "a"], testSettings()), /Usage/u);
});

test("the record step stores the turn without a model call and the write step runs the writer on its own", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-memory-step-"));
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.PLANABRAIN_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");
  delete process.env.PLANABRAIN_DECISION_PROVIDER;
  process.env.PLANABRAIN_TURN_STARTED_AT = String(Date.now());
  process.env.PLANABRAIN_CONVERSATION_ID = "chat_step";
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return codexStream("{\"operations\":[{\"op\":\"add\",\"kind\":\"relationship\",\"content\":\"사용자는 나비라는 고양이를 키운다\",\"importance\":0.7}]}");
  };
  const args = ["step", "chat_step", "우리 고양이 이름은 나비야", "확인했습니다."];
  try {
    assert.deepEqual(await runStep("record", args), { ok: true, result: { recorded: true, writer: "queued" } });
    assert.equal(calls, 0);
    assert.equal(listRecentTurns("chat_step", "chat_step").length, 2);
    assert.deepEqual(listMemories("step", "chat_step"), []);

    assert.deepEqual(await runStep("write", args), { ok: true, result: { writer: "done" } });
    assert.equal(calls, 1);
    assert.equal(listRecentTurns("chat_step", "chat_step").length, 2);
    assert.deepEqual(listMemories("step", "chat_step").map((memory) => memory.content), ["사용자는 나비라는 고양이를 키운다"]);
  } finally {
    globalThis.fetch = original;
    closeMemoryDatabases();
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("the record step reads an oversized transcript from its file and keeps the wire messages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-memory-transcript-"));
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const transcriptFile = path.join(dir, "transcript.tmp");
  const page = "웹페이지 본문 ".repeat(9000);
  await writeFile(transcriptFile, JSON.stringify({ wireMessages: [{ role: "user", content: page, readLinks: ["https://example.com/a"] }, { role: "assistant", content: "정리했습니다." }], epoch: 4 }));
  process.env.PLANABRAIN_MEMORY_DB_PATH = path.join(dir, "memory.sqlite");
  delete process.env.PLANABRAIN_DECISION_PROVIDER;
  delete process.env.PLANABRAIN_TRANSCRIPT_JSON;
  process.env.PLANABRAIN_TRANSCRIPT_JSON_FILE = transcriptFile;
  process.env.PLANABRAIN_TURN_STARTED_AT = String(Date.now());
  process.env.PLANABRAIN_CONVERSATION_ID = "chat_transcript";
  try {
    await runStep("record", ["transcript", "chat_transcript", "이 페이지 요약해줘", "정리했습니다."]);
    const assistant = listRecentTurns("chat_transcript", "chat_transcript").find((turn) => turn.role === "assistant");
    assert.deepEqual(assistant?.wireMessages, [{ role: "user", content: page, readLinks: ["https://example.com/a"] }, { role: "assistant", content: "정리했습니다." }]);
    assert.equal(assistant?.epoch, 4);
  } finally {
    closeMemoryDatabases();
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
