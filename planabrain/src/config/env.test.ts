import assert from "node:assert/strict";
import test from "node:test";

import { loadDecisionConfig } from "../decision/config.js";
import { loadMemoryConfig } from "../memory/config.js";
import { readIntSetting } from "./env.js";

test("integer settings take whole numbers in range and fall back on anything else", () => {
  assert.equal(readIntSetting(undefined, 60000, 0), 60000);
  assert.equal(readIntSetting("", 60000, 0), 60000);
  assert.equal(readIntSetting(" 180000 ", 60000, 0), 180000);
  assert.equal(readIntSetting("0", 60000, 0), 0);
  for (const raw of ["-1", "1e5", "24abc", "1.5", "0x10", "abc", "1,000"]) {
    assert.equal(readIntSetting(raw, 7, 0), 7, raw);
  }
  assert.equal(readIntSetting("199", 2500, 200, 10000), 2500);
  assert.equal(readIntSetting("10001", 2500, 200, 10000), 2500);
  assert.equal(readIntSetting("10000", 2500, 200, 10000), 10000);
});

test("memory and decision settings keep plain integers and default the rest", () => {
  const memory = loadMemoryConfig({ PLANABRAIN_MEMORY_MAX_TURNS: "30", PLANABRAIN_MEMORY_CONVERSATION_TTL_DAYS: "0", PLANABRAIN_MEMORY_MAX_ITEMS: "50abc" });
  assert.equal(memory.maxConversationTurns, 30);
  assert.equal(memory.conversationTtlMs, 14 * 24 * 60 * 60 * 1000);
  assert.equal(memory.maxMemoriesPerUser, 200);
  assert.equal(loadDecisionConfig({ OPENROUTER_API_KEY: "k", PLANABRAIN_DECISION_TIMEOUT_MS: "3000" })?.timeoutMs, 3000);
  assert.equal(loadDecisionConfig({ OPENROUTER_API_KEY: "k", PLANABRAIN_DECISION_TIMEOUT_MS: "1e3" })?.timeoutMs, 2500);
});
