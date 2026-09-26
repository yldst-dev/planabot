import assert from "node:assert/strict";
import test from "node:test";
import { invokeChatWithMetadata } from "./chat.js";
import { answerTurn } from "../chat/webSearchAnswer.js";
import { runExecution, currentExecution, ExecutionLimitError } from "../runtime/execution.js";
import { testSettings } from "../testing/settings.js";
import { codexInputText, codexStream, installFetch, jsonResponse } from "../testing/codex.js";

const SEARCH_RESULT = { results: [{ url: "https://news.example/report", title: "보고서", content: "검증 자료" }] };

test("pre-searched answers keep verified evidence and the replay transcript", async () => {
  const mock = installFetch((request) =>
    request.url.endsWith("/api/web_search") ? jsonResponse(SEARCH_RESULT) : codexStream("확인했습니다.\n출처번호: 1"),
  );
  try {
    const result = await answerTurn({ question: "오늘 뉴스를 검색해줘", settings: testSettings({ searchQueryRewriteEnabled: false }) });
    assert.match(codexInputText(mock.codexRequests()[0]!), /검증 자료/u);
    assert.doesNotMatch(result.answer, /확인 불가/u);
    assert.match(result.answer, /https:\/\/news.example\/report/u);
    assert.ok(result.transcript?.wireMessages.length);
  } finally { mock.restore(); }
});

test("continuation retains pre-search evidence", async () => {
  let calls = 0;
  const mock = installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) return jsonResponse(SEARCH_RESULT);
    calls += 1;
    return codexStream(calls === 1 ? "첫 문장." : "추가 문장.", { incomplete: calls === 1 });
  });
  try {
    await invokeChatWithMetadata({ settings: testSettings(), messages: [{ role: "user", content: "오늘 뉴스" }], preSearchQuery: "오늘 뉴스" });
    const chats = mock.codexRequests();
    assert.equal(chats.length, 2);
    assert.ok(chats.every((request) => codexInputText(request).includes("검증 자료")));
  } finally { mock.restore(); }
});

test("unsupported search evidence is excluded from future replay", async () => {
  const mock = installFetch((request) =>
    request.url.endsWith("/api/web_search") ? jsonResponse({ results: [] }) : codexStream("검증하지 않은 최신 정보입니다."),
  );
  try {
    const result = await answerTurn({ question: "오늘 뉴스를 검색해줘", settings: testSettings({ searchQueryRewriteEnabled: false }) });
    assert.match(result.answer, /확인 불가/u);
    assert.deepEqual(result.transcript, { wireMessages: [], epoch: 1 });
  } finally { mock.restore(); }
});

test("one execution budget covers continuation and records provider usage", async () => {
  const mock = installFetch(() => codexStream("첫 문장.", { incomplete: true, usage: { input_tokens: 12, output_tokens: 4 } }));
  try {
    await runExecution("budget-test", async () => {
      await assert.rejects(invokeChatWithMetadata({ settings: testSettings(), messages: [{ role: "user", content: "질문" }] }), ExecutionLimitError);
      assert.equal(currentExecution()?.inputTokens, 12);
      assert.equal(currentExecution()?.outputTokens, 4);
      assert.equal(currentExecution()?.usageReports, 1);
    }, { maxCalls: 1 });
    assert.equal(mock.requests.length, 1);
  } finally { mock.restore(); }
});
