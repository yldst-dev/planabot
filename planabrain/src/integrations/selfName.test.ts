import assert from "node:assert/strict";
import test from "node:test";

import {
  correctSelfName,
  sanitizeAssistantOutput,
} from "../chat/sanitizeOutput.js";

test("corrects first-person self references to 프라나", () => {
  assert.equal(correctSelfName("저는 아로나입니다."), "저는 프라나입니다.");
  assert.equal(correctSelfName("제 이름은 아로나예요."), "제 이름은 프라나예요.");
  assert.equal(correctSelfName("내 이름은 아로나야."), "내 이름은 프라나야.");
  assert.equal(correctSelfName("제가 아로나입니다."), "제가 프라나입니다.");
  assert.equal(correctSelfName("저는 A.R.O.N.A입니다."), "저는 프라나입니다.");
  assert.equal(correctSelfName("저는 ARONA입니다."), "저는 프라나입니다.");
});

test("keeps third-person mentions of 아로나 unchanged", () => {
  const text = "아로나는 다른 선생님을 돕고 있습니다.";
  assert.equal(correctSelfName(text), text);
  const question = "아로나와 무슨 사이인지 궁금하신가요.";
  assert.equal(correctSelfName(question), question);
});

test("keeps 아로나 when it is an object or modifier, not a self-introduction", () => {
  const senior = "저는 아로나 선배와 협력하여 선생님의 안전을 관리하겠습니다.";
  assert.equal(correctSelfName(senior), senior);
  const object = "저는 아로나를 도와드리고 있습니다.";
  assert.equal(correctSelfName(object), object);
  const comparison = "저는 아로나와 다른 인물입니다.";
  assert.equal(correctSelfName(comparison), comparison);
  const senior2 = "제가 아로나 선배에게 전달하겠습니다.";
  assert.equal(correctSelfName(senior2), senior2);
});

test("corrects quotative self-introduction", () => {
  assert.equal(
    correctSelfName("저를 아로나라고 불러 주세요."),
    "저를 프라나라고 불러 주세요.",
  );
});

test("sanitizeAssistantOutput applies the self-name correction", () => {
  const answer = sanitizeAssistantOutput("확인했습니다.\n선생님.\n저는 아로나입니다.");
  assert.match(answer, /저는 프라나입니다/u);
  assert.doesNotMatch(answer, /아로나/u);
});
