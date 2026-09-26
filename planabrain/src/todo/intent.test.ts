import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { interpretTodoRequest } from "./intent.js";
import { addTodo, listTodos } from "./store.js";

test("decided todo actions skip keyword detection", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-todo-intent-"));
  const previous = process.env.PLANABRAIN_TODO_DIR;
  process.env.PLANABRAIN_TODO_DIR = dir;
  try {
    await t.test("rule detection completes a todo from a bare past-tense sentence", async () => {
      await addTodo("rules", "운동");
      const result = await interpretTodoRequest("rules", "어제 운동했어");
      assert.equal(result.action, "complete");
      assert.equal((await listTodos("rules")).items[0]?.completed, true);
    });

    await t.test("a decided add registers without the todo keyword", async () => {
      const result = await interpretTodoRequest("decided", "우유 사기 추가해줘", "add");
      assert.equal(result.action, "add");
      assert.equal((await listTodos("decided")).items[0]?.content, "우유 사기");
    });

    await t.test("a decided list ignores mutation keywords", async () => {
      const result = await interpretTodoRequest("decided", "지운 거 말고 남은 거 보여줘", "list");
      assert.equal(result.action, "list");
      assert.equal((await listTodos("decided")).items.length, 1);
    });
  } finally {
    if (previous === undefined) delete process.env.PLANABRAIN_TODO_DIR; else process.env.PLANABRAIN_TODO_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
