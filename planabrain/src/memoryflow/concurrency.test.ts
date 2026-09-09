import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemoryEngine } from "./memory-engine.js";
import { JsonMemoryStore } from "./json-store.js";
import { SqliteMemoryStore } from "./sqlite-store.js";
import { buildScopeDescriptor } from "./storage.js";
import { MemoryConflictError } from "./concurrency.js";
import { createMemoryStore } from "./memory-store.js";
import { loadConfig } from "./config.js";
import { loadUserMemory, appendUserMemory, resetScopedUserMemory } from "../memory/userMemoryStore.js";

for (const storeKind of ["json", "sqlite"] as const) {
  test(`${storeKind} preserves exchanges across separate processes`, async (context) => {
    if (storeKind === "sqlite" && Number(process.versions.node.split(".")[0]) < 22) return context.skip("node:sqlite is unavailable");
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-process-"));
    const options = { rootDir: root, sqlitePath: path.join(root, "state.sqlite"), storeKind, compactionEnabled: false, groupMemoryEnabled: false };
    const engine = new LocalMemoryEngine(options);
    const moduleUrl = new URL(import.meta.url.endsWith(".ts") ? "./memory-engine.ts" : "./memory-engine.js", import.meta.url).href;
    const run = promisify(execFile);
    try {
      await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath, [
        ...process.execArgv, "--input-type=module", "-e",
        `const { LocalMemoryEngine } = await import(${JSON.stringify(moduleUrl)});
         const engine = new LocalMemoryEngine(${JSON.stringify(options)});
         try { await engine.rememberExchange({ userId: "actor-${index}", chatId: "chat", conversationId: "conversation", requestId: "process-${index}", userText: "질문입니다", assistantText: "답변입니다" }); }
         finally { engine.close(); }`,
      ], { timeout: 20_000 })));
      assert.equal((await engine.listConversationTurns({ chatId: "chat", conversationId: "conversation" })).length, 8);
    } finally {
      engine.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${storeKind} resets participants after working turns have been removed`, async (context) => {
    if (storeKind === "sqlite" && Number(process.versions.node.split(".")[0]) < 22) return context.skip("node:sqlite is unavailable");
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-reset-"));
    const store = storeKind === "sqlite" ? new SqliteMemoryStore(path.join(root, "state.sqlite")) : new JsonMemoryStore(root);
    const scope = buildScopeDescriptor({ userId: "conversation", chatId: "chat", conversationId: "topic", scopeKind: "conversation" });
    try {
      const state = await store.loadState(scope);
      state.participantIds = ["actor"];
      state.summary.items.push({ id: "summary", text: "private-reset-marker", fromTurnId: "a", toTurnId: "b", at: Date.now(), salience: 1, embedding: [] });
      await store.saveState(scope, state);
      assert.equal(await store.resetUser("actor"), true);
      assert.equal((await store.loadState(scope)).summary.items.length, 0);
      if (storeKind === "json") {
        const files = await readdir(root, { recursive: true });
        for (const file of files.filter((file) => file.endsWith(".json"))) {
          assert.equal((await readFile(path.join(root, file), "utf8")).includes("private-reset-marker"), false);
        }
      }
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${storeKind} preserves concurrent exchanges and deduplicates request IDs`, async (context) => {
    if (storeKind === "sqlite" && Number(process.versions.node.split(".")[0]) < 22) return context.skip("node:sqlite is unavailable");
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-concurrent-"));
    const options = { rootDir: root, sqlitePath: path.join(root, "state.sqlite"), storeKind, compactionEnabled: false, groupMemoryEnabled: false };
    const first = new LocalMemoryEngine(options);
    const second = new LocalMemoryEngine(options);
    const common = { chatId: "chat", conversationId: "conversation", userText: "질문입니다", assistantText: "답변입니다" };
    try {
      await Promise.all([
        first.rememberExchange({ ...common, userId: "actor-a", requestId: "request-a" }),
        second.rememberExchange({ ...common, userId: "actor-b", requestId: "request-b" }),
      ]);
      assert.equal((await first.listConversationTurns(common)).length, 4);
      await first.rememberExchange({ ...common, userId: "actor-a", requestId: "request-a" });
      assert.equal((await first.listConversationTurns(common)).length, 4);
      await first.resetUser("actor-a");
      assert.equal((await first.listConversationTurns(common)).length, 0);
    } finally {
      first.close();
      second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${storeKind} rejects stale writes including writes after a reset`, async (context) => {
    if (storeKind === "sqlite" && Number(process.versions.node.split(".")[0]) < 22) return context.skip("node:sqlite is unavailable");
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-version-"));
    const store = storeKind === "sqlite" ? new SqliteMemoryStore(path.join(root, "state.sqlite")) : new JsonMemoryStore(root);
    const scope = buildScopeDescriptor({ userId: "actor", chatId: "chat" });
    try {
      const stale = await store.loadState(scope);
      await store.saveState(scope, stale);
      await assert.rejects(store.saveState(scope, stale), MemoryConflictError);
      const beforeReset = await store.loadState(scope);
      await store.removeScope(scope);
      await assert.rejects(store.saveState(scope, beforeReset), MemoryConflictError);
      for (let index = 0; index < 5; index += 1) await store.saveState(scope, await store.loadState(scope));
      await assert.rejects(store.saveState(scope, stale), MemoryConflictError);
      assert.equal((await store.loadState(scope)).revision, 7);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("compatibility memory isolates chats and conversations and supports reset", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "scoped-memory-"));
  const params = { memoryDir, userId: "actor", chatScope: "private", conversationId: "one", maxMessages: 20 };
  try {
    await appendUserMemory({ ...params, messages: [{ role: "human", content: "개인 대화입니다", at: Date.now() }, { role: "ai", content: "확인했습니다", at: Date.now() + 1 }] });
    assert.equal((await loadUserMemory(params)).length, 2);
    assert.equal((await loadUserMemory({ ...params, chatScope: "group" })).length, 0);
    assert.equal((await loadUserMemory({ ...params, conversationId: "two" })).length, 0);
    await resetScopedUserMemory(params.userId, memoryDir);
    assert.equal((await loadUserMemory(params)).length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a corrupt SQLite database does not silently switch storage", async (context) => {
  if (Number(process.versions.node.split(".")[0]) < 22) return context.skip("node:sqlite is unavailable");
  const root = await mkdtemp(path.join(os.tmpdir(), "corrupt-memory-"));
  const sqlitePath = path.join(root, "state.sqlite");
  try {
    await writeFile(sqlitePath, "invalid database content");
    assert.throws(() => createMemoryStore({ ...loadConfig(), rootDir: root, sqlitePath, storeKind: "sqlite" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
