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
    await t.test("a bare past-tense sentence completes a todo only when the classifier decided", async () => {
      await addTodo("rules", "운동");
      assert.equal((await interpretTodoRequest("rules", "어제 운동했어")).handled, false);
      assert.equal((await listTodos("rules")).items[0]?.completed, false);
      assert.equal((await interpretTodoRequest("rules", "어제 운동했어", "complete")).action, "complete");
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
      assert.equal((await interpretTodoRequest("bounds", "운동 했어")).handled, false);
      assert.equal((await interpretTodoRequest("bounds", "운동 했어", "complete")).action, "complete");
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
      assert.match((await interpretTodoRequest("edit", "할 일 두유 사기 우유로 바꿔줘")).message, /^확인 필요\.\n선생님\.\n어느 항목을 무엇으로 바꿀지 확인하지 못했습니다\./u);
      assert.deepEqual((await listTodos("edit")).items.map((item) => item.content), ["할머니께 전화", "두유 사기"]);
      for (const content of ["주변 청소", "해변 청소"]) await addTodo("shore", content);
      await interpretTodoRequest("shore", "할 일 해변 청소 삭제해줘");
      assert.deepEqual((await listTodos("shore")).items.map((item) => item.content), ["주변 청소"]);
    });

    await t.test("item names with 할 거 still complete while plans and extra words after a name stay open", async () => {
      for (const content of ["주말 할거리 정리", "청소", "운동하기"]) await addTodo("plans", content);
      for (const text of ["운동 할 거라고 했어", "운동 할 거였는데 깜빡했어", "운동은 이따 할 거고 지금은 쉬었어", "운동 할 거니까 완료 처리는 내일 해줘", "운동 할 거 같아 완료는 나중에", "운동 할 거잖아 완료 처리하지 마", "운동 해야 했던 거 깜빡했어", "운동 해야 했던 거 포기했어"]) {
        assert.equal((await interpretTodoRequest("plans", text)).handled, false, text);
      }
      assert.equal((await interpretTodoRequest("plans", "운동 할 거였는데 깜빡했어", "complete")).handled, false);
      assert.equal((await interpretTodoRequest("plans", "할 일 주말 할거리 정리 완료")).action, "complete");
      assert.equal((await interpretTodoRequest("plans", "할 일 청소 해야 했던 거 다 했어")).message.split("\n")[0], "확인 필요.");
      assert.deepEqual((await listTodos("plans")).items.filter((item) => !item.completed).map((item) => item.content), ["청소", "운동하기"]);
    });

    await t.test("updates without particles never write a cut-off name and adds, inner particles and date-only edits stay safe", async () => {
      for (const content of ["우유 사기", "청소", "방 정리"]) await addTodo("cut", content);
      for (const text of ["할 일 두 번째 거 방 청소로 바꿔줘", "할 일 마지막 거 책상 정리로 바꿔줘"]) {
        assert.equal((await interpretTodoRequest("cut", text)).message.split("\n")[0], "확인 필요.", text);
      }
      assert.deepEqual((await listTodos("cut")).items.map((item) => item.content), ["우유 사기", "청소", "방 정리"]);
      await interpretTodoRequest("cut", "할 일 두 번째 거를 방 청소로 바꿔줘");
      await interpretTodoRequest("cut", "할 일 마지막 거는 책상 정리로 바꿔줘");
      assert.deepEqual((await listTodos("cut")).items.map((item) => item.content), ["우유 사기", "방 청소", "책상 정리"]);
      for (const content of ["이번 주 보고서", "1번 버스 타기", "2번 출구에서 만나기"]) await addTodo("names", content);
      await interpretTodoRequest("names", "할 일 이번 주 보고서를 다음 주 보고서로 바꿔줘");
      await interpretTodoRequest("names", "할 일 1번 버스 타기에서 회의로 바꿔줘");
      assert.deepEqual((await listTodos("names")).items.map((item) => item.content), ["다음 주 보고서", "회의", "2번 출구에서 만나기"]);
      for (const content of ["우유", "우유 사기", "택배를 보내기", "택배 찾기", "주소 확인"]) await addTodo("inner", content);
      assert.match((await interpretTodoRequest("inner", "할 일 우유 사기 두유 사기로 바꿔줘")).message, /^확인 필요\.\n선생님\.\n어느 항목을 무엇으로 바꿀지 확인하지 못했습니다\./u);
      await interpretTodoRequest("inner", "할 일 택배를 보내기를 택배 부치기로 바꿔줘");
      assert.equal((await interpretTodoRequest("inner", "할 일에 주소를 회사 주소로 변경 추가해줘")).action, "add");
      for (const text of ["할 일 우유 사기를 내일로 바꿔줘", "할 일 우유 사기를 완료로 바꿔줘", "할 일 우유 사기를 맨 위로 바꿔줘"]) {
        assert.match((await interpretTodoRequest("inner", text)).error ?? "", /^날짜나 시각, 상태, 순서는 할 일 내용으로 바꾸지 않습니다\./u, text);
      }
      assert.deepEqual((await listTodos("inner")).items.map((item) => item.content), ["우유", "우유 사기", "택배 부치기", "택배 찾기", "주소 확인", "주소를 회사 주소로 변경"]);
      for (const content of ["운동", "운동하기", "보고서 작성"]) await addTodo("exact", content);
      await interpretTodoRequest("exact", "할 일에서 운동 지워줘");
      await interpretTodoRequest("exact", "할 일 2번 삭제 부탁해");
      assert.deepEqual((await listTodos("exact")).items.map((item) => item.content), ["운동하기"]);
    });

    await t.test("negative, excluding and two-action commands change nothing on either path", async () => {
      for (const content of ["우유 사기", "청소"]) await addTodo("neg", content);
      for (const text of ["할 일 우유 사기 삭제하지 마", "할 일 우유 사기 지우지 마", "할 일 우유 사기 삭제 안 해도 돼", "할 일 우유 사기 완료 취소해줘", "할 일 우유 사기 체크 해제해줘", "할 일 우유 사기는 완료 아니야", "할 일 우유 사기 빼고 다 지워줘", "할 일 우유 사기 말고 나머지 다 지워줘", "할 일 우유 사기 완료하고 청소 삭제해줘", "할 일 우유 사기 지우고 청소 추가해줘", "할 일 우유 사기 완료한 거 되돌려줘", "할 일 우유 사기 대신 청소 완료"]) {
        const result = await interpretTodoRequest("neg", text);
        assert.equal(result.message.split("\n")[0], "확인 불가.", text);
      }
      for (const [text, action] of [["우유 사기 삭제하지 마", "delete"], ["우유 사기 완료 취소해줘", "complete"], ["우유 사기 완료하고 청소 삭제해줘", "delete"]] as const) {
        assert.equal((await interpretTodoRequest("neg", text, action)).message.split("\n")[0], "확인 불가.", text);
      }
      assert.equal((await interpretTodoRequest("neg", "할 일에 운동 추가하지 마")).handled, false);
      assert.deepEqual((await listTodos("neg")).items.map((item) => [item.content, item.completed]), [["우유 사기", false], ["청소", false]]);
    });

    await t.test("partial or shared names are asked back with numbers on both paths while 이번 is never a position", async () => {
      for (const content of ["할머니께 전화", "해변 청소", "주변 청소"]) await addTodo("ask", content);
      const many = "어느 항목인지 하나로 정하지 못했습니다. 번호와 작업을 함께 다시 말씀해 주십시오.";
      for (const [text, action, error] of [["할 일 청소 삭제해줘", undefined, many], ["할 일 할머니 완료", undefined, "이 항목이 맞으면 번호와 작업을 함께 다시 말씀해 주십시오."], ["청소 지워줘", "delete", many], ["할 일 청소 산책으로 바꿔줘", undefined, "어느 항목을 무엇으로 바꿀지 확인하지 못했습니다. 아래 예처럼 번호 뒤에 '을', 새 내용 뒤에 '로'를 붙여 다시 말씀해 주십시오."]] as const) {
        const result = await interpretTodoRequest("ask", text, action);
        assert.equal(result.error, error, text);
        assert.match(result.message, /^확인 필요\.\n선생님\./u, text);
      }
      const asked = await interpretTodoRequest("ask", "할 일 청소 삭제해줘");
      assert.match(asked.message, /\n후보: 2번 해변 청소, 3번 주변 청소\n예: 할 일 2번 삭제해줘\n\n1번 할머니께 전화\n2번 해변 청소\n3번 주변 청소$/u);
      for (const [text, action] of [["첫 번째 거 삭제해줘", undefined], ["마지막 거 삭제", "delete"], ["주변 거 지워줘", undefined]] as const) {
        assert.notEqual((await interpretTodoRequest("ask", `직전 프라나 응답:\n${asked.message}\n\n질문:\n${text}`, action)).action, "none", text);
      }
      assert.equal((await listTodos("ask")).items.length, 3);
      assert.equal((await interpretTodoRequest("ask", `직전 프라나 응답:\n${asked.message}\n\n질문:\n3번 삭제해줘`)).action, "delete");
      assert.deepEqual((await listTodos("ask")).items.map((item) => item.content), ["할머니께 전화", "해변 청소"]);
      await addTodo("ask", "주변 청소");
      await interpretTodoRequest("ask", "할 일 이번 거 완료");
      assert.ok((await listTodos("ask")).items.every((item) => !item.completed));
      const reply = "직전 프라나 응답:\n오늘 할 일 입니다. 선생님.\n\n- [ ] 할머니께 전화\n- [ ] 해변 청소\n- [ ] 주변 청소\n\n질문:\n2번 삭제해줘";
      await interpretTodoRequest("ask", reply);
      assert.deepEqual((await listTodos("ask")).items.map((item) => item.content), ["할머니께 전화", "주변 청소"]);
    });

    await t.test("completion needs a completion word at the end with the item first, otherwise only a bare decided reply", async () => {
      for (const content of ["사과 사기", "빨래", "회의"]) await addTodo("done", content);
      for (const text of ["사과 사기 하러 갈게", "룸메가 사과 사기 했어", "사과 사기 50%쯤 했어", "할 일 빨래는 내일 하고 사과 사기 완료", "할 일 사과 사기 완료는 나중에", "할 일 사과 사기 완료한 줄 알았는데"]) {
        await interpretTodoRequest("done", text, "complete");
        await interpretTodoRequest("done", text);
      }
      assert.ok((await listTodos("done")).items.every((item) => !item.completed));
      assert.equal((await interpretTodoRequest("done", "사과 사기 했어", "complete")).action, "complete");
      assert.equal((await interpretTodoRequest("done", "회의도", "complete")).action, "complete");
      assert.deepEqual((await listTodos("done")).items.filter((item) => item.completed).map((item) => item.content), ["사과 사기", "회의"]);
    });

    await t.test("names that a particle or a position could also mean are asked back", async () => {
      for (const content of ["제주도 여행 예약", "제주"]) await addTodo("near", content);
      for (const content of ["2번 출구에서 만나기", "1번 버스 타기", "회의 준비"]) await addTodo("spots", content);
      for (const content of ["3", "2", "1"]) await addTodo("digits", content);
      for (const content of ["엄마를 돕기", "엄마"]) await addTodo("mom", content);
      for (const [user, text] of [["near", "할 일 제주도 삭제"], ["near", "할 일 제주도도 완료"], ["near", "할 일 제주도를 수영으로 바꿔줘"], ["spots", "할 일 2번째 항목 삭제"], ["digits", "할 일 1 삭제"], ["mom", "할 일 엄마를 돕기 11시 회의로 바꿔줘"]] as const) {
        assert.equal((await interpretTodoRequest(user, text)).message.split("\n")[0], "확인 필요.", text);
      }
      for (const user of ["near", "spots", "digits", "mom"]) {
        assert.ok((await listTodos(user)).items.every((item) => !item.completed), user);
      }
      assert.deepEqual((await listTodos("mom")).items.map((item) => item.content), ["엄마를 돕기", "엄마"]);
      assert.equal((await listTodos("digits")).items.length, 3);
    });

    await t.test("long commands under the rule limit stay fast with a full list", async () => {
      for (let index = 0; index < 100; index += 1) await addTodo("full", `항목 ${index} 정리하기`);
      const started = performance.now();
      for (const unit of ["다 ", "가 로 ", "을 ", "완료 ", "할 일 ", "ㅋ", "1월 1일 "]) {
        for (const action of [undefined, "update", "delete", "complete"] as const) {
          await interpretTodoRequest("full", `할 일 ${unit.repeat(150)}`.slice(0, 590), action);
        }
      }
      await interpretTodoRequest("full", `할 일에 우유 추가해줘${"ㅋ".repeat(60)}?`);
      await interpretTodoRequest("full", `할 일에 ${"1월 1일 ".repeat(90)}우유 추가해줘`);
      await interpretTodoRequest("full", `할 일 1번을 ${"1월 1일 ".repeat(90)}우유로 바꿔줘`);
      assert.ok(performance.now() - started < 3_000);
      const fillers = performance.now();
      for (const word of ["음", "아", "흠", "좀"]) {
        await interpretTodoRequest("full", `할 일 ${`${word} `.repeat(280)}없는항목 삭제해줘`.slice(0, 590));
      }
      assert.ok(performance.now() - fillers < 1_000);
    });

    await t.test("completions with other words after a name, two items or a reply to a confirmation are asked back or left alone", async () => {
      for (const content of ["빨래", "우유 사기", "보고서 작성", "빨래 개기"]) await addTodo("loose", content);
      for (const text of ["할 일 빨래는 못 해서 우유 사기만 했어", "할 일 보고서 작성은 다음에, 빨래는 끝냈어", "할 일 빨래 완료. 우유 사기도 완료", "할 일 빨래 이따 완료해줘", "할 일 빨래 개 완료"]) {
        assert.equal((await interpretTodoRequest("loose", text)).message.split("\n")[0], "확인 필요.", text);
      }
      assert.ok((await listTodos("loose")).items.every((item) => !item.completed));
      for (const content of ["우유 사기", "빨래"]) await addTodo("confirm", content);
      const done = await interpretTodoRequest("confirm", "할 일 우유 사기 완료");
      await interpretTodoRequest("confirm", `직전 프라나 응답:\n${done.message}\n\n질문:\n네, 했어요`);
      assert.deepEqual((await listTodos("confirm")).items.filter((item) => item.completed).map((item) => item.content), ["우유 사기"]);
      await addTodo("status", "우유 사기");
      assert.match((await interpretTodoRequest("status", "할 일 우유 사기를 완료에서 미완료로 바꿔줘")).error ?? "", /^날짜나 시각, 상태, 순서는/u);
      const asked = await interpretTodoRequest("status", "할 일 우유 사기 두유로 바꿔줘");
      assert.match(asked.message, /\n예: 할 일 1번을 새 내용으로 바꿔줘\n/u);
      assert.equal((await interpretTodoRequest("status", `직전 프라나 응답:\n${asked.message}\n\n질문:\n할 일 1번을 새 내용으로 바꿔줘`)).message.split("\n")[0], "확인 필요.");
      assert.deepEqual((await listTodos("status")).items.map((item) => item.content), ["우유 사기"]);
    });

    await t.test("words inside item names do not route to reminders or edits and casual command endings still work", async () => {
      for (const content of ["3시 알림 끄기", "폰 요금제 5G로 변경", "숙제 했는지 확인", "빨래", "청소", "설거지"]) await addTodo("names2", content);
      for (const text of ["프라나야 할 일 3시 알림 끄기 완료", "할 일 폰 요금제 5G로 변경 완료", "할 일 숙제 했는지 확인 완료", "할 일 빨래 완료~ ㅋㅋ", "할 일 설거지 완료 끝"]) {
        assert.equal((await interpretTodoRequest("names2", text.replace(/^프라나야 /u, ""))).action, "complete", text);
      }
      assert.equal((await interpretTodoRequest("names2", "할 일 청소 지워 주라")).action, "delete");
      assert.deepEqual((await listTodos("names2")).items.map((item) => [item.content, item.completed]), [["3시 알림 끄기", true], ["폰 요금제 5G로 변경", true], ["숙제 했는지 확인", true], ["빨래", true], ["설거지", true]]);
      for (const text of ["할 일에 우유 추가해 줘", "할 일에 두유 추가 좀 해줘", "할 일에 빵 추가요", "할 일에 잼 추가해줄래?", "할 일에 쌀 추가해줘 ㅠㅠ", "할 일에 물 추가해줘🙏"]) {
        assert.equal((await interpretTodoRequest("adds", text)).action, "add", text);
      }
      assert.deepEqual((await listTodos("adds")).items.map((item) => item.content), ["우유", "두유", "빵", "잼", "쌀", "물"]);
    });

    await t.test("question-form adds, plans and a second action after a rename change nothing", async () => {
      for (const text of ["할 일에 서점 들르기 추가해?", "할 일에 서점 들르기 추가해요?", "할 일에 서점 들르기 추가?", "할 일에 서점 들르기 나중에 추가할게"]) {
        assert.equal((await interpretTodoRequest("qadd", text)).handled, false, text);
      }
      for (const text of ["할 일에 잼 추가해줘?", "할 일에 쌀 추가해줄 수 있어?", "할 일에 나중에 읽을 책 추가해줘"]) {
        assert.equal((await interpretTodoRequest("qadd", text)).action, "add", text);
      }
      assert.deepEqual((await listTodos("qadd")).items.map((item) => item.content), ["잼", "쌀", "나중에 읽을 책"]);
      for (const content of ["환기", "분리수거"]) await addTodo("plan2", content);
      for (const text of ["할 일 환기를 화초 분갈이로 바꾸려고 했는데 그냥 둘게", "할 일 환기를 화초 분갈이로 바꾸려다 말았어", "할 일 분리수거 삭제하려고 했는데 그냥 둘래"]) {
        assert.equal((await interpretTodoRequest("plan2", text)).handled, false, text);
      }
      for (const text of ["할 일 환기를 화초 분갈이로 바꿔줘 그리고 분리수거 삭제해줘", "할 일 환기를 화초 분갈이로 바꿔줘. 분리수거 삭제해줘", "할 일 환기를 화초 분갈이로 바꿔주고 분리수거 삭제해줘", "할 일 환기를 화초 분갈이로 바꿔줘 또 분리수거도 완료"]) {
        assert.equal((await interpretTodoRequest("plan2", text)).error, "여러 작업이 함께 담긴 요청이라 그대로 두었습니다. 한 번에 하나씩 말씀해 주십시오.", text);
      }
      assert.match((await interpretTodoRequest("plan2", "할 일 분리수거를 완료로 바꿔줘")).error ?? "", /'할 일 2번 완료'처럼/u);
      assert.deepEqual((await listTodos("plan2")).items.map((item) => [item.content, item.completed]), [["환기", false], ["분리수거", false]]);
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
