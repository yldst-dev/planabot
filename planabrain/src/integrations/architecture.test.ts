import assert from "node:assert/strict";
import test from "node:test";
import { invokeChatWithMetadata } from "./chat.js";
import { answerTurn } from "../chat/webSearchAnswer.js";
import { readGoogleGrounding } from "./responseMetadata.js";
import { runExecution, currentExecution, ExecutionLimitError } from "../runtime/execution.js";
import { testSettings } from "../testing/settings.js";
import { buildCompactedSummary } from "../memoryflow/compaction.js";

type RequestBody = { messages: Array<{ role: string; content: unknown; }>; tools?: unknown; model?: string; };

function mockRequests(reply: (body: RequestBody, url: string, index: number) => unknown): { requests: RequestBody[]; restore: () => void; } {
  const original = globalThis.fetch;
  const requests: RequestBody[] = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push(body);
    return new Response(JSON.stringify(reply(body, String(input), requests.length)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

function answer(content = "확인했습니다.", finishReason = "stop"): unknown {
  return { choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
}

test("continuous native search stays enabled and keeps verified evidence", async () => {
  const mock = mockRequests(() => ({ choices: [{ finish_reason: "stop", message: { content: "확인했습니다.", annotations: [{ type: "url_citation", url_citation: { url: "https://news.example/report", title: "보고서" } }] } }] }));
  try {
    const result = await answerTurn({ question: "오늘 뉴스를 검색해줘", settings: testSettings({ openRouterWebSearchBackend: "plugin", searchQueryRewriteEnabled: false }) });
    assert.ok(mock.requests[0].tools);
    assert.doesNotMatch(result.answer, /확인 불가/u);
    assert.match(result.answer, /https:\/\/news.example\/report/u);
    assert.ok(result.transcript?.wireMessages.length);
  } finally { mock.restore(); }
});

test("Cerebras preserves image content in the compatible request", async () => {
  const mock = mockRequests(() => answer());
  try {
    await invokeChatWithMetadata({ settings: testSettings({ aiProvider: "cerebras", cerebrasApiKey: "test-key", cerebrasBaseUrl: "https://cerebras.example/v1" }), messages: [{ role: "user", content: "사진 설명", images: [{ data: "AAAA", mimeType: "image/png" }] }] });
    assert.deepEqual(mock.requests[0].messages[0].content, [{ type: "text", text: "사진 설명" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  } finally { mock.restore(); }
});

test("continuation retains pre-search evidence", async () => {
  let calls = 0;
  const mock = mockRequests((_body, url) => {
    if (url.endsWith("/api/web_search")) return { results: [{ url: "https://news.example/report", title: "보고서", content: "검증 자료" }] };
    calls += 1;
    return answer(calls === 1 ? "첫 문장." : "추가 문장.", calls === 1 ? "length" : "stop");
  });
  try {
    await invokeChatWithMetadata({ settings: testSettings(), messages: [{ role: "user", content: "오늘 뉴스" }], preSearchQuery: "오늘 뉴스" });
    const chats = mock.requests.filter((request) => request.messages);
    assert.equal(chats.length, 2);
    assert.ok(chats.every((request) => request.messages.some((message) => String(message.content).includes("검증 자료"))));
  } finally { mock.restore(); }
});

test("geminiweb forces native search and skips citation fail-closed", async () => {
  const mock = mockRequests(() => answer("검색으로 확인한 오늘 뉴스입니다."));
  try {
    const result = await answerTurn({
      question: "오늘 뉴스를 검색해줘",
      settings: testSettings({
        aiProvider: "geminiweb",
        geminiWebApiKey: "sk-gemini-test",
        geminiWebBaseUrl: "http://10.0.0.5:8083/v1",
        ollamaWebSearchEnabled: true,
        continuousChat: false,
        searchQueryRewriteEnabled: false,
      }),
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].tools, undefined);
    const system = String(
      mock.requests[0].messages.find((message) => message.role === "system")?.content ?? "",
    );
    assert.match(system, /반드시 웹 검색으로 최신 정보를 확인/u);
    assert.doesNotMatch(system, /web_search 도구를 먼저 호출/u);
    assert.doesNotMatch(system, /웹 검색 도구를 사용할 수 없습니다/u);
    assert.doesNotMatch(result.answer, /확인 불가/u);
    assert.match(result.answer, /오늘 뉴스/u);
  } finally {
    mock.restore();
  }
});

test("geminiweb continuous prompt stays native and does not call ollama search", async () => {
  const mock = mockRequests((_body, url) => {
    if (url.endsWith("/api/web_search")) {
      throw new Error("geminiweb must not call ollama web_search");
    }
    return answer("확인했습니다.");
  });
  try {
    const result = await answerTurn({
      question: "오늘 뉴스를 검색해줘",
      settings: testSettings({
        aiProvider: "geminiweb",
        geminiWebApiKey: "sk-gemini-test",
        geminiWebBaseUrl: "http://10.0.0.5:8083/v1",
        ollamaWebSearchEnabled: true,
        continuousChat: true,
        searchQueryRewriteEnabled: false,
      }),
    });
    assert.equal(
      mock.requests.every((request) => request.tools === undefined),
      true,
    );
    const system = String(
      mock.requests[0].messages.find((message) => message.role === "system")?.content ?? "",
    );
    assert.match(system, /반드시 웹 검색으로 최신 정보를 확인/u);
    assert.doesNotMatch(result.answer, /확인 불가/u);
  } finally {
    mock.restore();
  }
});

test("unsupported search evidence is excluded from future replay", async () => {
  const mock = mockRequests(() => answer("검증하지 않은 최신 정보입니다."));
  try {
    const result = await answerTurn({ question: "오늘 뉴스를 검색해줘", settings: testSettings({ openRouterWebSearchBackend: "plugin", searchQueryRewriteEnabled: false }) });
    assert.match(result.answer, /확인 불가/u);
    assert.deepEqual(result.transcript, { wireMessages: [], epoch: 1 });
  } finally { mock.restore(); }
});

test("Google and Vertex grounding metadata use the same evidence contract", () => {
  const groundingMetadata = { groundingChunks: [{ web: { uri: "https://source.example/article", title: "근거" } }, { web: { uri: "javascript:bad" } }], webSearchQueries: ["검색어"] };
  const expected = { citations: [{ url: "https://source.example/article", title: "근거" }], searchUsed: true };
  assert.deepEqual(readGoogleGrounding({ candidates: [{ groundingMetadata }] }), expected);
  assert.deepEqual(readGoogleGrounding({ response_metadata: { groundingMetadata } }), expected);
});

test("one execution budget covers continuation and records provider usage", async () => {
  const mock = mockRequests(() => answer("첫 문장.", "length"));
  try {
    await runExecution("budget-test", async () => {
      await assert.rejects(invokeChatWithMetadata({ settings: testSettings({ openRouterWebSearchBackend: "plugin" }), messages: [{ role: "user", content: "질문" }] }), ExecutionLimitError);
      assert.equal(currentExecution()?.inputTokens, 12);
      assert.equal(currentExecution()?.outputTokens, 4);
      assert.equal(currentExecution()?.usageReports, 1);
    }, { maxCalls: 1 });
    assert.equal(mock.requests.length, 1);
  } finally { mock.restore(); }
});

test("memory compaction uses the auxiliary model without search tools", async () => {
  const values = { PLANABRAIN_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key", PLANABRAIN_AUX_PROVIDER: "openrouter", PLANABRAIN_AUX_MODEL: "summary-model" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const mock = mockRequests(() => answer("확정 사항: 테스트를 진행합니다."));
  try {
    await buildCompactedSummary({ turns: [{ id: "turn", role: "user", text: "테스트를 진행해 주세요", at: Date.now(), tokens: 12, salience: 0.5 }] });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].model, "summary-model");
    assert.equal(mock.requests[0].tools, undefined);
  } finally {
    mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("native Google SDK preserves images, grounding and the execution signal", async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  let payload: { contents: Array<{ parts: unknown[]; }>; } | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal;
    payload = JSON.parse(String(init?.body)) as typeof payload;
    return new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "확인했습니다." }] }, finishReason: "STOP", groundingMetadata: { groundingChunks: [{ web: { uri: "https://source.example/article", title: "근거" } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    await runExecution("native-google", async () => {
      const result = await invokeChatWithMetadata({ settings: testSettings({ aiProvider: "google", googleApiKey: "test-key" }), messages: [{ role: "user", content: "사진 설명", images: [{ mimeType: "image/png", data: "AAAA" }] }], enableSearchTool: true });
      assert.equal(result.searchUsed, true);
      assert.equal(result.citations[0]?.url, "https://source.example/article");
      assert.ok(signal);
      assert.equal(currentExecution()?.inputTokens, 10);
      assert.ok(payload?.contents[0].parts.some((part) => typeof part === "object" && part !== null && "inlineData" in part));
    });
  } finally { globalThis.fetch = original; }
});
