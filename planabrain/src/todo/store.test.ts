import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addTodo, completeTodo, deleteTodo, listTodos, updateTodo } from "./store.js";
import { readTodos, saveTodos } from "./persistence.js";

test("todo persistence preserves concurrent updates and damaged data", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-todos-"));
  const previous = process.env.PLANABRAIN_TODO_DIR;
  process.env.PLANABRAIN_TODO_DIR = dir;
  try {
    await t.test("parallel processes and requests keep every acknowledged item", async () => {
      const moduleUrl = new URL("./store.ts", import.meta.url).href;
      const code = `const { addTodo } = await import(${JSON.stringify(moduleUrl)}); await Promise.all(Array.from({length: 4}, (_, i) => addTodo('parallel', 'task-' + process.pid + '-' + i)));`;
      const children = Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(stderr)));
      }));
      await Promise.all([...children, ...Array.from({ length: 8 }, (_, i) => addTodo("parallel", `local-${i}`))]);
      const items = (await listTodos("parallel")).items;
      assert.equal(items.length, 24);
      assert.equal(new Set(items.map((item) => item.content)).size, 24);
      await Promise.all([
        completeTodo("parallel", items[0].id),
        updateTodo("parallel", items[1].id, "updated"),
        deleteTodo("parallel", items[2].id),
        addTodo("parallel", "added"),
      ]);
      const next = (await listTodos("parallel")).items;
      assert.equal(next.length, 24);
      assert.equal(next.find((item) => item.id === items[0].id)?.completed, true);
      assert.equal(next.find((item) => item.id === items[1].id)?.content, "updated");
      assert.equal(next.some((item) => item.id === items[2].id), false);
      assert.equal((await readdir(path.join(dir, "parallel.json.revisions"))).some((file) => file.endsWith(".tmp")), false);
    });

    await t.test("damaged legacy files are reported and never overwritten", async () => {
      const file = path.join(dir, "damaged.json");
      for (const damaged of ['{"version":1,"items":[', '{"version":1,"items":null}', '{"version":1,"items":[null]}']) {
        await writeFile(file, damaged);
        await assert.rejects(listTodos("damaged"));
        await assert.rejects(addTodo("damaged", "new"));
        assert.equal(await readFile(file, "utf8"), damaged);
      }
    });

    await t.test("legacy data migrates and stale writers cannot overwrite revisions", async () => {
      const item = (await addTodo("source", "legacy")).item!;
      const file = path.join(dir, "legacy.json");
      await writeFile(file, JSON.stringify({ version: 1, items: [item] }));
      assert.equal((await listTodos("legacy")).items.length, 1);
      await addTodo("legacy", "second");
      await addTodo("legacy", "third");
      await addTodo("legacy", "fourth");
      assert.equal(await saveTodos(file, 0, []), false);
      assert.equal((await readTodos(file)).items.length, 4);
      const latest = path.join(`${file}.revisions`, "3.json");
      await writeFile(latest, "broken");
      await assert.rejects(addTodo("legacy", "fifth"));
      assert.equal(await readFile(latest, "utf8"), "broken");
    });

    await t.test("an id-shaped query that no longer exists matches nothing", async () => {
      await addTodo("stale", "77c");
      assert.equal((await completeTodo("stale", "62177c1dd57b")).ok, false);
      assert.equal((await deleteTodo("stale", "62177c1dd57b")).ok, false);
      assert.deepEqual((await listTodos("stale")).items.map((item) => [item.content, item.completed]), [["77c", false]]);
    });

    await t.test("items added in the same millisecond keep their order after completion", async () => {
      const clock = t.mock.method(Date, "now", () => 1_900_000_000_000);
      for (const content of ["첫째", "둘째", "셋째"]) await addTodo("tied", content);
      const [first, second] = (await listTodos("tied")).items;
      await completeTodo("tied", first.id);
      await completeTodo("tied", second.id);
      clock.mock.restore();
      assert.deepEqual((await listTodos("tied")).items.map((item) => item.content), ["셋째", "첫째", "둘째"]);
    });
  } finally {
    if (previous === undefined) delete process.env.PLANABRAIN_TODO_DIR;
    else process.env.PLANABRAIN_TODO_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
