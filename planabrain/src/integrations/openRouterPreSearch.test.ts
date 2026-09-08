import assert from "node:assert/strict";
import test from "node:test";

import { answerWithWebSearch } from "../chat/webSearchAnswer.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { buildSearchQuery, invokeChatWithMetadata } from "./chat.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    aiProvider: "openrouter",
    openRouterApiKey: "gateway-key",
    openRouterBaseUrl: "http://gateway.example/v1",
    openRouterWebSearchEnabled: true,
    openRouterWebSearchBackend: "ollama",
    openRouterWebSearchMaxResults: 5,
    openRouterWebSearchMaxTotalResults: 15,
    openRouterWebSearchContextSize: "medium",
    cerebrasWebSearchEnabled: false,
    modelStudioWebSearchEnabled: false,
    ollamaApiKeys: ["ollama-key"],
    ollamaSearchHost: "https://ollama.example",
    ollamaWebSearchEnabled: false,
    ollamaWebFetchEnabled: false,
    ollamaWebSearchMaxResults: 3,
    ollamaToolMaxIterations: 4,
    webFetchEnabled: false,
    webFetchTimeoutMs: 1000,
    webFetchMaxBytes: 100000,
    webFetchMaxChars: 12000,
    webFetchMaxTotalChars: 18000,
    chatModel: "gemini-3.7-flash",
    deliveryRewriteEnabled: false,
    chatThinkingMode: "off",
    embeddingProvider: "openrouter",
    embeddingModel: "gemini-embedding-001",
    indexPath: ".planabrain/index.json",
    systemPrompt: "테스트 시스템",
    personaProfile: "live",
    intimacyEnabled: false,
    memoryEnabled: false,
    memoryMaxMessages: 0,
    memoryDir: ".planabrain/memory",
    ...overrides,
  } as Settings;
}

type RecordedRequest = { url: string; body: Record<string, unknown> };

function installFetchMock(options: { searchFails?: boolean } = {}): {
  requests: RecordedRequest[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/api/web_search")) {
      if (options.searchFails) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "대전 날씨",
              url: "https://weather.example/daejeon",
              content: "대전은 맑고 낮 최고 28도입니다.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "확인 완료.\n선생님.\n대전은 맑고 낮 최고 28도입니다." },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("buildSearchQuery strips request phrases but keeps short inputs", () => {
  assert.equal(buildSearchQuery("대전의 날씨를 알아봐줘"), "대전의 날씨");
  assert.equal(buildSearchQuery("오늘 원달러 환율 알려줘"), "오늘 원달러 환율");
  assert.equal(buildSearchQuery("비트코인 시세 좀 찾아봐 줘?"), "비트코인 시세");
  assert.equal(buildSearchQuery("비트코인 시세?"), "비트코인 시세");
  assert.equal(buildSearchQuery("검색해줘"), "검색해줘");
});

test("system prompt uses the search-context rules in pre-search mode", () => {
  const prompt = buildSystemPrompt(createSettings(), {
    searchEnabled: true,
    searchMode: "context",
  });
  assert.match(prompt, /\[웹 검색 결과\]/u);
  assert.doesNotMatch(prompt, /반드시 web_search 도구를 먼저 호출/u);
});

test("pre-search injects results before the last user message and records citations", async () => {
  const mock = installFetchMock();
  try {
    const result = await invokeChatWithMetadata({
      settings: createSettings(),
      enableSearchTool: true,
      preSearchQuery: "대전의 날씨",
      messages: [
        { role: "system", content: "시스템" },
        { role: "user", content: "대전의 날씨를 알아봐줘" },
      ],
    });

    assert.equal(mock.requests.length, 2);
    const [search, chat] = mock.requests;
    assert.ok(search.url.endsWith("/api/web_search"));
    assert.equal(search.body.query, "대전의 날씨");
    assert.equal(search.body.max_results, 3);
    assert.ok(chat.url.endsWith("/chat/completions"));
    assert.equal(chat.body.tools, undefined);
    const messages = chat.body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, "user");
    assert.match(messages[1].content, /\[웹 검색 결과\]/u);
    assert.match(messages[1].content, /https:\/\/weather\.example\/daejeon/u);
    assert.equal(messages[2].content, "대전의 날씨를 알아봐줘");
    assert.equal(result.searchUsed, true);
    assert.equal(result.citations[0]?.url, "https://weather.example/daejeon");
  } finally {
    mock.restore();
  }
});

test("pre-search failure falls back to a plain chat request", async () => {
  const mock = installFetchMock({ searchFails: true });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await invokeChatWithMetadata({
      settings: createSettings(),
      enableSearchTool: true,
      preSearchQuery: "대전의 날씨",
      messages: [{ role: "user", content: "대전의 날씨를 알아봐줘" }],
    });
    assert.equal(mock.requests.length, 2);
    const messages = mock.requests[1].body.messages as Array<{ content: string }>;
    assert.equal(messages.length, 1);
    assert.equal(result.searchUsed, false);
    assert.equal(result.citations.length, 0);
  } finally {
    console.error = originalError;
    mock.restore();
  }
});

test("pre-search is skipped without a query", async () => {
  const mock = installFetchMock();
  try {
    await invokeChatWithMetadata({
      settings: createSettings(),
      enableSearchTool: true,
      messages: [{ role: "user", content: "안녕" }],
    });
    assert.equal(mock.requests.length, 1);
    assert.ok(mock.requests[0].url.endsWith("/chat/completions"));
  } finally {
    mock.restore();
  }
});

test("weather questions answer with verified sources through the gateway", async () => {
  const mock = installFetchMock();
  try {
    const answer = await answerWithWebSearch({
      question:
        "메타정보:\n현재 시각: 2026-09-08 (화) 10:40:00 KST\n\n사용자 질문:\n대전의 날씨를 알아봐줘",
      currentTurnText: "대전의 날씨를 알아봐줘",
      settings: createSettings(),
    });
    assert.doesNotMatch(answer, /확인 불가/u);
    assert.match(answer, /낮 최고 28도/u);
    assert.match(answer, /출처: \[대전 날씨\]\(https:\/\/weather\.example\/daejeon\)/u);
    assert.equal(mock.requests[0].body.query, "대전의 날씨");
    const systemMessage = (mock.requests[1].body.messages as Array<{ content: string }>)[0];
    assert.match(systemMessage.content, /\[웹 검색 결과\]/u);
  } finally {
    mock.restore();
  }
});

test("greetings do not trigger a pre-search", async () => {
  const mock = installFetchMock();
  try {
    await answerWithWebSearch({
      question: "안녕",
      currentTurnText: "안녕",
      settings: createSettings(),
    });
    assert.equal(mock.requests.length, 1);
    assert.ok(mock.requests[0].url.endsWith("/chat/completions"));
  } finally {
    mock.restore();
  }
});
