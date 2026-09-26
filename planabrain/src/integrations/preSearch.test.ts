import assert from "node:assert/strict";
import test from "node:test";

import { answerTurn } from "../chat/webSearchAnswer.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { testSettings } from "../testing/settings.js";
import { codexStream, installFetch, jsonResponse } from "../testing/codex.js";
import { buildSearchQuery, invokeChatWithMetadata } from "./chat.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({ continuousChat: false, searchQueryRewriteEnabled: false, ...overrides });
}

type InputItem = { role: string; content: string; };

function installGateway(options: { searchFails?: boolean; } = {}): ReturnType<typeof installFetch> {
  return installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) {
      return options.searchFails
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse({ results: [{ title: "대전 날씨", url: "https://weather.example/daejeon", content: "대전은 맑고 낮 최고 28도입니다." }] });
    }
    if (request.url.endsWith("/responses")) {
      return codexStream("확인 완료.\n선생님.\n대전은 맑고 낮 최고 28도입니다.");
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
}

test("buildSearchQuery strips request phrases but keeps short inputs", () => {
  assert.equal(buildSearchQuery("대전의 날씨를 알아봐줘"), "대전의 날씨");
  assert.equal(buildSearchQuery("오늘 원달러 환율 알려줘"), "오늘 원달러 환율");
  assert.equal(buildSearchQuery("비트코인 시세 좀 찾아봐 줘?"), "비트코인 시세");
  assert.equal(buildSearchQuery("비트코인 시세?"), "비트코인 시세");
  assert.equal(buildSearchQuery("검색해줘"), "검색해줘");
});

test("system prompt uses the search-context rules when search is enabled", () => {
  const prompt = buildSystemPrompt(createSettings(), { searchEnabled: true });
  assert.match(prompt, /\[웹 검색 결과\]/u);
  assert.doesNotMatch(prompt, /web_search 도구를 먼저 호출/u);
  assert.match(buildSystemPrompt(createSettings()), /웹 검색 도구를 사용할 수 없습니다/u);
});

test("pre-search injects results before the last user message and records citations", async () => {
  const mock = installGateway();
  try {
    const result = await invokeChatWithMetadata({
      settings: createSettings(),
      preSearchQuery: "대전의 날씨",
      messages: [
        { role: "system", content: "시스템" },
        { role: "user", content: "대전의 날씨를 알아봐줘" },
      ],
    });

    assert.equal(mock.requests.length, 2);
    const [search, chat] = mock.requests;
    assert.ok(search?.url.endsWith("/api/web_search"));
    assert.equal(search?.body.query, "대전의 날씨");
    assert.equal(search?.body.max_results, 3);
    assert.equal(chat?.body.instructions, "시스템");
    const input = chat?.body.input as InputItem[];
    assert.equal(input.length, 2);
    assert.match(input[0]!.content, /\[웹 검색 결과\]/u);
    assert.match(input[0]!.content, /https:\/\/weather\.example\/daejeon/u);
    assert.equal(input[1]!.content, "대전의 날씨를 알아봐줘");
    assert.equal(result.searchUsed, true);
    assert.equal(result.citations[0]?.url, "https://weather.example/daejeon");
  } finally {
    mock.restore();
  }
});

test("pre-search failure falls back to a plain chat request", async () => {
  const mock = installGateway({ searchFails: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await invokeChatWithMetadata({
      settings: createSettings(),
      preSearchQuery: "대전의 날씨",
      messages: [{ role: "user", content: "대전의 날씨를 알아봐줘" }],
    });
    assert.equal(mock.requests.length, 2);
    assert.equal((mock.requests[1]?.body.input as InputItem[]).length, 1);
    assert.equal(result.searchUsed, false);
    assert.equal(result.citations.length, 0);
  } finally {
    console.error = originalError;
    mock.restore();
  }
});

test("pre-search is skipped without a query", async () => {
  const mock = installGateway();
  try {
    await invokeChatWithMetadata({ settings: createSettings(), messages: [{ role: "user", content: "안녕" }] });
    assert.equal(mock.requests.length, 1);
    assert.ok(mock.requests[0]?.url.endsWith("/responses"));
  } finally {
    mock.restore();
  }
});

test("weather questions answer with verified sources through the gateway", async () => {
  const mock = installGateway();
  try {
    const { answer } = await answerTurn({
      question: "메타정보:\n현재 시각: 2026-09-08 (화) 10:40:00 KST\n\n사용자 질문:\n대전의 날씨를 알아봐줘",
      currentTurnText: "대전의 날씨를 알아봐줘",
      settings: createSettings(),
    });
    assert.doesNotMatch(answer, /확인 불가/u);
    assert.match(answer, /낮 최고 28도/u);
    assert.match(answer, /출처: \[대전 날씨\]\(https:\/\/weather\.example\/daejeon\)/u);
    assert.equal(mock.requests[0]?.body.query, "대전의 날씨");
    assert.match(String(mock.requests[1]?.body.instructions), /\[웹 검색 결과\]/u);
  } finally {
    mock.restore();
  }
});

test("greetings do not trigger a pre-search", async () => {
  const mock = installGateway();
  try {
    await answerTurn({ question: "안녕", currentTurnText: "안녕", settings: createSettings() });
    assert.equal(mock.requests.length, 1);
    assert.ok(mock.requests[0]?.url.endsWith("/responses"));
  } finally {
    mock.restore();
  }
});
