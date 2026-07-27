import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeAssistantOutput,
  stripToolCallEcho,
} from "../chat/sanitizeOutput.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";

const promptSettings = { systemPrompt: "PERSONA" } as Settings;

test("replaces an answer that is only a tool call echo", () => {
  const raw =
    'web_search(queries=["육상자위대 군가집 앨범", "JGSDF album"])ㄴㅇㄹ';
  const answer = sanitizeAssistantOutput(raw);
  assert.doesNotMatch(answer, /web_search/u);
  assert.match(answer, /응답 생성에 실패했습니다/u);
});

test("removes a tool call echo but keeps the real answer", () => {
  const raw = 'web_search(queries=["a", "b"])\n확인했습니다.\n선생님.';
  assert.equal(stripToolCallEcho(raw), "확인했습니다.\n선생님.");
});

test("removes a multi-line tool call echo", () => {
  const raw = 'web_search(\n  queries=["a",\n  "b"]\n)\n확인했습니다.';
  assert.equal(stripToolCallEcho(raw), "확인했습니다.");
});

test("keeps ordinary sentences that mention search", () => {
  const raw = "검색(웹)으로 확인했습니다.\n선생님. 결과입니다.";
  assert.equal(stripToolCallEcho(raw), raw);
});

test("only instructs tool usage when the search tool is attached", () => {
  const enabled = buildSystemPrompt(promptSettings, { searchEnabled: true });
  assert.match(enabled, /web_search 도구를 먼저 호출/u);

  const disabled = buildSystemPrompt(promptSettings, { searchEnabled: false });
  assert.doesNotMatch(disabled, /web_search 도구를 먼저 호출/u);
  assert.match(disabled, /웹 검색 도구를 사용할 수 없습니다/u);
});

test("defaults to the search-disabled rules", () => {
  const fallback = buildSystemPrompt(promptSettings);
  assert.doesNotMatch(fallback, /web_search 도구를 먼저 호출/u);
});
