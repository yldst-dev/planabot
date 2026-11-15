import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTurnEnv } from "./ask.js";

const KEYS = [
  "PLANABRAIN_CURRENT_TURN_TEXT",
  "PLANABRAIN_CURRENT_TURN_TEXT_FILE",
  "PLANABRAIN_MEMORY_CONTEXT",
  "PLANABRAIN_MEMORY_CONTEXT_FILE",
  "PLANABRAIN_TURN_SIGNALS",
  "PLANABRAIN_TURN_SIGNALS_FILE",
] as const;

const SIGNALS = { route: "todo_list", routeConfident: true, currentInfo: false, searchFollowUp: false, socialOnly: false };

async function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("ask reads the current turn text, memory context and signals from their files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabrain-ask-env-"));
  const textFile = path.join(dir, "text.tmp");
  const memoryFile = path.join(dir, "memory.tmp");
  const signalsFile = path.join(dir, "signals.tmp");
  const text = `프라나야 ${"긴 메시지 ".repeat(8000)}`;
  const memory = `기억 ${"나비 ".repeat(8000)}`;
  await Promise.all([writeFile(textFile, text), writeFile(memoryFile, memory), writeFile(signalsFile, JSON.stringify(SIGNALS))]);
  try {
    await withEnv(
      {
        PLANABRAIN_CURRENT_TURN_TEXT: "inline text",
        PLANABRAIN_CURRENT_TURN_TEXT_FILE: textFile,
        PLANABRAIN_MEMORY_CONTEXT_FILE: memoryFile,
        PLANABRAIN_TURN_SIGNALS_FILE: signalsFile,
      },
      async () => {
        assert.deepEqual(await readTurnEnv(), { currentTurnText: text, memoryContext: memory, signals: SIGNALS });
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ask still reads small values from env and a missing file fails loudly", async () => {
  await withEnv(
    { PLANABRAIN_CURRENT_TURN_TEXT: "inline text", PLANABRAIN_MEMORY_CONTEXT: "inline memory", PLANABRAIN_TURN_SIGNALS: JSON.stringify(SIGNALS) },
    async () => {
      assert.deepEqual(await readTurnEnv(), { currentTurnText: "inline text", memoryContext: "inline memory", signals: SIGNALS });
    },
  );
  await withEnv({ PLANABRAIN_MEMORY_CONTEXT_FILE: path.join(os.tmpdir(), "planabrain-ask-env-missing.tmp") }, async () => {
    await assert.rejects(readTurnEnv(), /PLANABRAIN_MEMORY_CONTEXT_FILE 읽기 실패/u);
  });
});
