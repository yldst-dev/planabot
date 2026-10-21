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

    await t.test("keyword completion needs the whole todo at a word boundary and skips negations, questions and reminders", async () => {
      for (const content of ["네일", "응원", "운동하기", "청소", "다이어리"]) await addTodo("bounds", content);
      for (const text of ["네 일단 했어", "응 원래 했어", "청소 안 했어", "청소 했어?", "네, 할일 완료했어", "할일 다 했어"]) {
        await interpretTodoRequest("bounds", text);
      }
      await interpretTodoRequest("bounds", "네", "complete");
      assert.ok((await listTodos("bounds")).items.every((item) => !item.completed));
      assert.equal((await interpretTodoRequest("bounds", "할일 알림 오후 3시에 등록해줘")).handled, false);
      assert.equal((await interpretTodoRequest("bounds", "운동 했어")).action, "complete");
      assert.deepEqual((await listTodos("bounds")).items.filter((item) => item.completed).map((item) => item.content), ["운동하기"]);
    });

    await t.test("sentences about only meaning to do a todo leave it open and long text skips rule parsing", async () => {
      for (const content of ["운동하기", "공부하기"]) await addTodo("intent", content);
      for (const text of ["운동 하려고 했어", "운동 할까 했어", "운동 했어야 했는데", "공부 하라고 했어"]) {
        assert.equal((await interpretTodoRequest("intent", text)).handled, false, text);
      }
      assert.ok((await listTodos("intent")).items.every((item) => !item.completed));
      const long = `할 일 ${"가 로 ".repeat(1_023)}`;
      const started = performance.now();
      assert.equal((await interpretTodoRequest("intent", long)).handled, false);
      assert.equal((await interpretTodoRequest("intent", long, "list")).action, "list");
      assert.ok(performance.now() - started < 1_000);
    });

    await t.test("edits, deletions and completions name their item without the todo words and never touch another item", async () => {
      for (const content of ["할머니께 전화", "우유 사기"]) await addTodo("edit", content);
      assert.equal((await interpretTodoRequest("edit", "할 일 우유 사기를 두유 사기로 바꿔줘")).action, "update");
      assert.equal((await interpretTodoRequest("edit", "할 일 두유 사기 우유로 바꿔줘")).action, "update");
      assert.deepEqual((await listTodos("edit")).items.map((item) => item.content), ["할머니께 전화", "우유"]);
      for (const content of ["주변 청소", "해변 청소"]) await addTodo("shore", content);
      await interpretTodoRequest("shore", "할 일 해변 청소 삭제해줘");
      assert.deepEqual((await listTodos("shore")).items.map((item) => item.content), ["주변 청소"]);
    });

    await t.test("item names with 할 거 or 해야 했던 still complete while plans stay open", async () => {
      for (const content of ["주말 할거리 정리", "청소", "운동하기"]) await addTodo("plans", content);
      for (const text of ["운동 할 거라고 했어", "운동 할 거였는데 깜빡했어", "운동은 이따 할 거고 지금은 쉬었어", "운동 할 거니까 완료 처리는 내일 해줘", "운동 할 거 같아 완료는 나중에", "운동 할 거잖아 완료 처리하지 마", "운동 해야 했던 거 깜빡했어", "운동 해야 했던 거 포기했어"]) {
        assert.equal((await interpretTodoRequest("plans", text)).handled, false, text);
      }
      assert.equal((await interpretTodoRequest("plans", "운동 할 거였는데 깜빡했어", "complete")).handled, false);
      for (const text of ["주말 할거리 정리 완료", "청소 해야 했던 거 다 했어"]) {
        assert.equal((await interpretTodoRequest("plans", text)).action, "complete", text);
      }
      assert.deepEqual((await listTodos("plans")).items.filter((item) => !item.completed).map((item) => item.content), ["운동하기"]);
    });

    await t.test("updates without particles never write a cut-off name and adds, inner particles and date-only edits stay safe", async () => {
      for (const content of ["우유 사기", "청소", "방 정리"]) await addTodo("cut", content);
      await interpretTodoRequest("cut", "할 일 두 번째 거 방 청소로 바꿔줘");
      await interpretTodoRequest("cut", "할 일 마지막 거 책상 정리로 바꿔줘");
      assert.deepEqual((await listTodos("cut")).items.map((item) => item.content), ["우유 사기", "방 청소", "책상 정리"]);
      for (const content of ["이번 주 보고서", "1번 버스 타기", "2번 출구에서 만나기"]) await addTodo("names", content);
      await interpretTodoRequest("names", "할 일 이번 주 보고서 다음 주 보고서로 바꿔줘");
      await interpretTodoRequest("names", "할 일 1번 버스 타기 회의로 바꿔줘");
      assert.deepEqual((await listTodos("names")).items.map((item) => item.content), ["다음 주 보고서", "회의", "2번 출구에서 만나기"]);
      for (const content of ["우유", "우유 사기", "택배를 보내기", "택배 찾기", "주소 확인"]) await addTodo("inner", content);
      assert.match((await interpretTodoRequest("inner", "할 일 우유 사기 두유 사기로 바꿔줘")).message, /번호로 다시 말씀해 주십시오/u);
      await interpretTodoRequest("inner", "할 일 택배를 보내기를 택배 부치기로 바꿔줘");
      assert.equal((await interpretTodoRequest("inner", "할 일에 주소를 회사 주소로 변경 추가해줘")).action, "add");
      assert.equal((await interpretTodoRequest("inner", "할 일 우유 사기를 내일로 바꿔줘")).error, "날짜나 시각만으로는 할 일 내용을 바꾸지 않습니다. 알림이 필요하면 일정으로 등록해 주십시오.");
      assert.deepEqual((await listTodos("inner")).items.map((item) => item.content), ["우유", "우유 사기", "택배 부치기", "택배 찾기", "주소 확인", "주소를 회사 주소로 변경"]);
      for (const content of ["운동", "운동하기", "보고서 작성"]) await addTodo("exact", content);
      await interpretTodoRequest("exact", "할 일에서 운동 지워줘");
      await interpretTodoRequest("exact", "할 일 2번 삭제 부탁해");
      assert.deepEqual((await listTodos("exact")).items.map((item) => item.content), ["운동하기"]);
    });

    await t.test("negative, excluding and two-action commands change nothing on either path", async () => {
      for (const content of ["우유 사기", "청소"]) await addTodo("neg", content);
      for (const text of ["할 일 우유 사기 삭제하지 마", "할 일 우유 사기 지우지 마", "할 일 우유 사기 삭제 안 해도 돼", "할 일 우유 사기 완료 취소해줘", "할 일 우유 사기 체크 해제해줘", "할 일 우유 사기는 완료 아니야", "할 일 우유 사기 빼고 다 지워줘", "할 일 우유 사기 말고 나머지 다 지워줘", "할 일 우유 사기 완료하고 청소 삭제해줘", "할 일 우유 사기 지우고 청소 추가해줘", "할 일에 운동 추가하지 마"]) {
        const result = await interpretTodoRequest("neg", text);
        assert.equal(result.message.split("\n")[0], "확인 불가.", text);
      }
      for (const [text, action] of [["우유 사기 삭제하지 마", "delete"], ["우유 사기 완료 취소해줘", "complete"], ["우유 사기 완료하고 청소 삭제해줘", "delete"]] as const) {
        assert.equal((await interpretTodoRequest("neg", text, action)).message.split("\n")[0], "확인 불가.", text);
      }
      assert.deepEqual((await listTodos("neg")).items.map((item) => [item.content, item.completed]), [["우유 사기", false], ["청소", false]]);
    });

    await t.test("partial or shared names are asked back with numbers on both paths while 이번 is never a position", async () => {
      for (const content of ["할머니께 전화", "해변 청소", "주변 청소"]) await addTodo("ask", content);
      for (const [text, action] of [["할 일 청소 삭제해줘", undefined], ["할 일 할머니 완료", undefined], ["청소 지워줘", "delete"], ["할 일 청소 산책으로 바꿔줘", undefined]] as const) {
        const result = await interpretTodoRequest("ask", text, action);
        assert.equal(result.error, "어느 항목인지 하나로 정하지 못했습니다. 번호로 다시 말씀해 주십시오.", text);
        assert.match(result.message, /^확인 필요\.\n선생님\./u, text);
      }
      assert.match((await interpretTodoRequest("ask", "할 일 청소 삭제해줘")).message, /\n2번 해변 청소\n3번 주변 청소\n예: 할 일 2번 삭제해줘\n/u);
      await interpretTodoRequest("ask", "할 일 이번 거 완료");
      assert.ok((await listTodos("ask")).items.every((item) => !item.completed));
      const reply = "직전 프라나 응답:\n오늘 할 일 입니다. 선생님.\n\n- [ ] 할머니께 전화\n- [ ] 해변 청소\n- [ ] 주변 청소\n\n질문:\n2번 삭제해줘";
      await interpretTodoRequest("ask", reply);
      assert.deepEqual((await listTodos("ask")).items.map((item) => item.content), ["할머니께 전화", "주변 청소"]);
    });

    await t.test("long commands under the rule limit stay fast with a full list", async () => {
      for (let index = 0; index < 100; index += 1) await addTodo("full", `항목 ${index} 정리하기`);
      const started = performance.now();
      for (const unit of ["다 ", "가 로 ", "을 ", "완료 ", "할 일 "]) {
        for (const action of [undefined, "update", "delete", "complete"] as const) {
          await interpretTodoRequest("full", `할 일 ${unit.repeat(150)}`.slice(0, 590), action);
        }
      }
      assert.ok(performance.now() - started < 3_000);
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
