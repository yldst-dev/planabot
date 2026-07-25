import assert from "node:assert/strict";
import test from "node:test";

import { finalizeAnswerForDelivery } from "../chat/deliveryRewrite.js";
import {
  answerWithWebSearch,
  isCurrentInformationRequest,
  isExplicitSearchRequest,
} from "../chat/webSearchAnswer.js";
import type { Settings } from "../config/settings.js";
import {
  invokeChatWithMetadata,
  parseOpenRouterCitations,
} from "./gemini/chat.js";

function createSettings(
  overrides: Partial<Settings> = {},
): Settings {
  return {
    aiProvider: "openrouter",
    openRouterApiKey: "test-key",
    openRouterBaseUrl: "https://openrouter.example/api/v1",
    cerebrasWebSearchEnabled: false,
    openRouterWebSearchEnabled: true,
    openRouterWebSearchMaxResults: 5,
    openRouterWebSearchMaxTotalResults: 15,
    openRouterWebSearchContextSize: "medium",
    ollamaApiKeys: [],
    ollamaWebSearchEnabled: false,
    ollamaWebFetchEnabled: false,
    ollamaWebSearchMaxResults: 5,
    ollamaToolMaxIterations: 4,
    webFetchEnabled: false,
    webFetchTimeoutMs: 1000,
    webFetchMaxBytes: 100000,
    webFetchMaxChars: 12000,
    webFetchMaxTotalChars: 18000,
    chatModel: "google/gemini-3-flash-preview",
    deliveryRewriteEnabled: false,
    chatThinkingMode: "off",
    embeddingProvider: "openrouter",
    embeddingModel: "gemini-embedding-001",
    indexPath: ".planabrain/index.json",
    systemPrompt: "테스트 시스템",
    memoryEnabled: false,
    memoryMaxMessages: 0,
    memoryDir: ".planabrain/memory",
    ...overrides,
  };
}

function installFetchQueue(
  bodies: unknown[],
  requests: Array<{ input: string; init?: RequestInit }> = [],
): () => void {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    const body = bodies[index];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("parses, sanitizes, and deduplicates OpenRouter URL citations", () => {
  const citations = parseOpenRouterCitations([
    {
      type: "url_citation",
      url_citation: {
        url: "https://example.com/report?token=secret#part",
        title: "  Example   Report ",
        content: "  supporting   evidence ",
      },
    },
    {
      type: "url_citation",
      url_citation: {
        url: "https://example.com/report",
        title: "Duplicate",
      },
    },
    {
      type: "url_citation",
      url_citation: {
        url: "http://example.com/insecure",
        title: "Insecure",
      },
    },
  ]);

  assert.deepEqual(citations, [
    {
      url: "https://example.com/report",
      title: "Duplicate",
      evidence: "supporting evidence",
    },
  ]);
});

test("merges citations and search usage across continuations", async () => {
  const restore = installFetchQueue([
    {
      choices: [
        {
          finish_reason: "length",
          message: {
            content: "첫 문장입니다.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://first.example/report",
                  title: "First",
                  content: "first evidence",
                },
              },
            ],
          },
        },
      ],
      usage: { server_tool_use: { web_search_requests: 1 } },
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "둘째 문장입니다.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://first.example/report#duplicate",
                  title: "First duplicate",
                },
              },
              {
                type: "url_citation",
                url_citation: {
                  url: "https://second.example/report",
                  title: "Second",
                },
              },
            ],
          },
        },
      ],
    },
  ]);

  try {
    const result = await invokeChatWithMetadata({
      settings: createSettings(),
      enableSearchTool: true,
      messages: [{ role: "user", content: "최신 정보를 알려줘" }],
    });

    assert.match(result.content, /첫 문장입니다/u);
    assert.match(result.content, /둘째 문장입니다/u);
    assert.equal(result.searchUsed, true);
    assert.deepEqual(
      result.citations.map((citation) => citation.url),
      [
        "https://first.example/report",
        "https://second.example/report",
      ],
    );
    assert.equal(result.citations[0]?.evidence, "first evidence");
  } finally {
    restore();
  }
});

test("uses only currentTurnText to decide whether search is enabled", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const restore = installFetchQueue(
    [
      {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "같이 이야기하겠습니다.\n선생님." },
          },
        ],
      },
    ],
    requests,
  );

  try {
    const answer = await answerWithWebSearch({
      question:
        "메모리 컨텍스트:\n과거 질문: 삿포로 날씨와 환율\n\n메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n심심해",
      currentTurnText: "심심해",
      settings: createSettings(),
      memoryContext: "working:\n- user: 삿포로 날씨와 환율",
    });

    assert.match(answer, /같이 이야기하겠습니다/u);
    const payload = JSON.parse(String(requests[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    assert.equal("tools" in payload, false);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert.equal(messages.at(-1)?.content, "심심해");
    assert.equal(
      messages.some((message) =>
        String(message.content).includes("[PAST_MEMORY_DATA_BEGIN]"),
      ),
      true,
    );
  } finally {
    restore();
  }
});

test("fails closed when a current-information request has no verified citation", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const restore = installFetchQueue(
    [
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "현재 환율은 1달러에 1,500원입니다.\n출처: Example",
            },
          },
        ],
      },
    ],
    requests,
  );

  try {
    const answer = await answerWithWebSearch({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n오늘 원달러 환율 알려줘",
      currentTurnText: "오늘 원달러 환율 알려줘",
      settings: createSettings(),
    });

    assert.match(answer, /확인 불가/u);
    assert.match(answer, /추측해서 답하지 않겠습니다/u);
    const payload = JSON.parse(String(requests[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    assert.equal(Array.isArray(payload.tools), true);
  } finally {
    restore();
  }
});

test("explicit search request attaches the search tool and keeps the answer", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const restore = installFetchQueue(
    [
      {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "해당 회사를 확인했습니다." },
          },
        ],
      },
    ],
    requests,
  );

  try {
    const answer = await answerWithWebSearch({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n이 회사에 대해 검색해줘",
      currentTurnText: "이 회사에 대해 검색해줘",
      settings: createSettings(),
    });

    assert.doesNotMatch(answer, /확인 불가/u);
    assert.match(answer, /해당 회사를 확인했습니다/u);
    const payload = JSON.parse(String(requests[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    assert.equal(Array.isArray(payload.tools), true);
  } finally {
    restore();
  }
});

test("replaces model-authored sources with verified HTTPS citation URLs", async () => {
  const restore = installFetchQueue([
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content:
              "확인한 현재 환율입니다.\n출처:\nhttps://fake.example/rates",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://verified.example/rates",
                  title: "Verified",
                  content: "rate evidence",
                },
              },
            ],
          },
        },
      ],
      usage: { server_tool_use: { web_search_requests: 1 } },
    },
  ]);

  try {
    const answer = await answerWithWebSearch({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n오늘 원달러 환율 알려줘",
      currentTurnText: "오늘 원달러 환율 알려줘",
      settings: createSettings(),
    });

    assert.doesNotMatch(answer, /fake\.example/u);
    assert.match(answer, /출처: \[Verified\]\(https:\/\/verified\.example\/rates\)/u);
  } finally {
    restore();
  }
});

test("verified citations bypass delivery rewrite", async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("rewrite must not run");
  }) as typeof fetch;

  try {
    const answer = await finalizeAnswerForDelivery({
      question: "오늘 환율",
      answer: "확인했습니다.\n출처: 모델이 쓴 출처",
      settings: createSettings({
        deliveryRewriteEnabled: true,
        deliveryMaxOutputTokens: 1,
      }),
      verifiedCitations: [
        { url: "https://verified.example/rates", title: "검증된 환율" },
        { url: "http://insecure.example/rates", title: "안전하지 않음" },
      ],
    });

    assert.equal(fetchCalls, 0);
    assert.doesNotMatch(answer, /모델이 쓴 출처/u);
    assert.match(
      answer,
      /출처: \[검증된 환율\]\(https:\/\/verified\.example\/rates\)/u,
    );
    assert.doesNotMatch(answer, /insecure/u);
  } finally {
    globalThis.fetch = original;
  }
});

test("source labels strip brackets, newlines and control characters", async () => {
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [
      {
        url: "https://a.example/one",
        title: "제목 [대괄호] (괄호)\n둘째 줄\t탭",
      },
    ],
  });

  assert.equal(
    answer,
    "본문입니다.\n\n출처: [제목 대괄호 괄호 둘째 줄 탭](https://a.example/one)",
  );
});

test("source labels fall back to hostname without www", async () => {
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [
      { url: "https://www.example.com/path" },
      { url: "https://b.example/two", title: "   " },
      { url: "https://c.example/three", title: "()[]" },
    ],
  });

  assert.match(answer, /\[example\.com\]\(https:\/\/www\.example\.com\/path\)/u);
  assert.match(answer, /\[b\.example\]\(https:\/\/b\.example\/two\)/u);
  assert.match(answer, /\[c\.example\]\(https:\/\/c\.example\/three\)/u);
});

test("source labels are truncated to 60 characters", async () => {
  const longTitle = "가".repeat(120);
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [{ url: "https://long.example/a", title: longTitle }],
  });

  const label = answer.match(/\[([^\]]+)\]\(https:\/\/long\.example\/a\)/u)?.[1];
  assert.equal(label, "가".repeat(60));
});

test("citation URLs containing a closing parenthesis are skipped", async () => {
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [
      { url: "https://paren.example/a(b)c", title: "괄호 URL" },
      { url: "https://ok.example/a", title: "정상" },
    ],
  });

  assert.doesNotMatch(answer, /paren\.example/u);
  assert.equal(answer, "본문입니다.\n\n출처: [정상](https://ok.example/a)");
});

test("sensitive query parameters are still stripped from labeled sources", async () => {
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [
      {
        url: "https://secret.example/a?token=abc&q=rate#frag",
        title: "민감 파라미터",
      },
    ],
  });

  assert.doesNotMatch(answer, /token|abc|frag/u);
  assert.match(answer, /q=rate/u);
});

test("current-information classifier ignores casual conversation", () => {
  assert.equal(isCurrentInformationRequest("심심해"), false);
  assert.equal(
    isCurrentInformationRequest(
      "메타정보:\n현재 시각: 2026-07-24\n사용자 질문:\n심심해",
    ),
    false,
  );
  assert.equal(
    isCurrentInformationRequest(
      "메타정보:\n현재 시각: 2026-07-24\n사용자 질문:\nTODO 컨텍스트:\n- 삿포로 날씨 확인\n\n심심해",
    ),
    false,
  );
  assert.equal(isCurrentInformationRequest("오늘 원달러 환율 알려줘"), true);
  assert.equal(isCurrentInformationRequest("삿포로 날씨 알려줘"), true);
});

test("explicit search request classifier detects search directives", () => {
  assert.equal(isExplicitSearchRequest("이 회사에 대해 검색해줘"), true);
  assert.equal(isExplicitSearchRequest("검색 좀 해봐"), true);
  assert.equal(isExplicitSearchRequest("웹에서 찾아봐"), true);
  assert.equal(isExplicitSearchRequest("관련 자료 찾아줘"), true);
  assert.equal(isExplicitSearchRequest("이거 알아봐 줘"), true);
  assert.equal(isExplicitSearchRequest("조사해줘"), true);
  assert.equal(isExplicitSearchRequest("구글링해줘"), true);
  assert.equal(isExplicitSearchRequest("심심해"), false);
  assert.equal(isExplicitSearchRequest("오늘 기분이 어때"), false);
  assert.equal(
    isExplicitSearchRequest(
      "메타정보:\n현재 시각: 2026-07-24\n사용자 질문:\nTODO 컨텍스트:\n- 자료 검색하기\n\n심심해",
    ),
    false,
  );
});

test("long-range weather policy returns before model invocation", async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("model invocation must not run");
  }) as typeof fetch;

  try {
    const answer = await answerWithWebSearch({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n삿포로의 2026년 8월 말 날씨를 알려줘",
      currentTurnText: "삿포로의 2026년 8월 말 날씨를 알려줘",
      settings: createSettings(),
    });

    assert.equal(fetchCalls, 0);
    assert.match(answer, /단기 예보 범위를 벗어납니다/u);
  } finally {
    globalThis.fetch = original;
  }
});
