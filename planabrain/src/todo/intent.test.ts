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

    await t.test("rule detection never edits or deletes a todo without todo words", async () => {
      await addTodo("questions", "메일");
      await addTodo("questions", "보고서 작성");
      assert.equal((await interpretTodoRequest("questions", "메일 삭제하는 법 알려줘")).handled, false);
      assert.equal((await interpretTodoRequest("questions", "보고서를 영어로 바꿔줘")).handled, false);
      assert.deepEqual((await listTodos("questions")).items.map((item) => item.content), ["메일", "보고서 작성"]);
      assert.equal((await interpretTodoRequest("questions", "할 일에서 메일 지워줘")).action, "delete");
      assert.deepEqual((await listTodos("questions")).items.map((item) => item.content), ["보고서 작성"]);
    });

    await t.test("casual replies that sound like positions do not complete todos", async () => {
      for (const content of ["메일", "보고서", "운동", "공부"]) await addTodo("casual", content);
      for (const text of ["두 번 했어", "네, 했어.", "처음 했어", "마지막 했어"]) {
        assert.equal((await interpretTodoRequest("casual", text)).handled, false, text);
      }
      assert.ok((await listTodos("casual")).items.every((item) => !item.completed));
    });

    await t.test("replies that only share a prefix with a todo leave it open and 할일 works without a space", async () => {
      for (const content of ["네이버 예약 확인", "다이어리 쓰기", "그래프 그리기", "응급약 사기"]) await addTodo("overlap", content);
      for (const text of ["네, 했어.", "다 했어", "그래 했어", "응 했어"]) {
        assert.equal((await interpretTodoRequest("overlap", text)).handled, false, text);
      }
      for (const text of ["할일 2번 완료했어", "할일 첫번째 끝냈어", "마지막 할일 끝냈어"]) {
        assert.equal((await interpretTodoRequest("overlap", text)).action, "complete", text);
      }
      assert.deepEqual((await listTodos("overlap")).items.filter((item) => !item.completed).map((item) => item.content), ["그래프 그리기"]);
    });

    await t.test("a decided add registers without the todo keyword", async () => {
      const result = await interpretTodoRequest("decided", "우유 사기 추가해줘", "add");
      assert.equal(result.action, "add");
      assert.equal((await listTodos("decided")).items[0]?.content, "우유 사기");
    });

    await t.test("numbers pick open items by position and confirmations name the item", async () => {
      await addTodo("picks", "메일 보내기");
      await addTodo("picks", "보고서 작성");
      const removed = await interpretTodoRequest("picks", "할 일 2 삭제");
      assert.equal(removed.action, "delete");
      assert.match(removed.message, /"보고서 작성" 항목을 지웠습니다/u);
      assert.equal((await interpretTodoRequest("picks", "할 일 1 삭제")).action, "delete");
      assert.deepEqual((await listTodos("picks")).items, []);
    });

    await t.test("a reply to an empty schedule list is not treated as a todo", async () => {
      const reply = "직전 프라나 응답:\n일정 확인.\n선생님.\n등록된 항목이 없습니다.\n\n질문:\n내일 3시 회의 알림 등록해줘";
      assert.equal((await interpretTodoRequest("cross", reply)).handled, false);
      assert.deepEqual((await listTodos("cross")).items, []);
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
