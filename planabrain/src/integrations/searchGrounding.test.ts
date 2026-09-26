import assert from "node:assert/strict";
import test from "node:test";

import { finalizeAnswerForDelivery } from "../chat/deliveryRewrite.js";
import {
  answerTurn,
  isCurrentInformationRequest,
  isExplicitSearchRequest,
  isInformationRequestForm,
} from "../chat/webSearchAnswer.js";
import type { Settings } from "../config/settings.js";
import { testSettings } from "../testing/settings.js";
import { codexStream, installFetch, jsonResponse } from "../testing/codex.js";
import { parseWebSearchCitations } from "./chat.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({ intimacyEnabled: true, continuousChat: false, searchQueryRewriteEnabled: false, ...overrides });
}

function installGateway(search: unknown, answer: string): ReturnType<typeof installFetch> {
  return installFetch((request) =>
    request.url.endsWith("/api/web_search") ? jsonResponse(search) : codexStream(answer),
  );
}

test("parses, sanitizes, and deduplicates web search citations", () => {
  const citations = parseWebSearchCitations([{
    results: [
      { url: "https://example.com/report?token=secret#part", title: "  Example   Report ", content: "  supporting   evidence " },
      { url: "https://example.com/report", title: "Duplicate" },
      { url: "http://example.com/insecure", title: "Insecure" },
    ],
  }]);

  assert.deepEqual(citations, [
    {
      url: "https://example.com/report",
      title: "Duplicate",
      evidence: "supporting evidence",
    },
  ]);
});

test("uses only currentTurnText for the current-information gate", async () => {
  const mock = installGateway({ results: [] }, "같이 이야기하겠습니다.\n선생님.");
  try {
    const { answer } = await answerTurn({
      question:
        "메모리 컨텍스트:\n과거 질문: 삿포로 날씨와 환율\n\n메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n심심해",
      currentTurnText: "심심해",
      settings: createSettings(),
      memoryContext: "working:\n- user: 삿포로 날씨와 환율",
    });

    assert.match(answer, /같이 이야기하겠습니다/u);
    assert.equal(mock.requests.some((request) => request.url.endsWith("/api/web_search")), false);
    const input = mock.codexRequests()[0]?.body.input as Array<{ content: string; }>;
    assert.equal(input.at(-1)?.content, "심심해");
    assert.equal(input.some((message) => message.content.includes("[PAST_MEMORY_DATA_BEGIN]")), true);
  } finally {
    mock.restore();
  }
});

test("fails closed when a current-information request has no verified citation", async () => {
  const mock = installGateway({ results: [] }, "현재 환율은 1달러에 1,500원입니다.\n출처: Example");
  try {
    const { answer } = await answerTurn({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n오늘 원달러 환율 알려줘",
      currentTurnText: "오늘 원달러 환율 알려줘",
      settings: createSettings(),
    });

    assert.match(answer, /확인 불가/u);
    assert.match(answer, /추측해서 답하지 않겠습니다/u);
    assert.ok(mock.requests.some((request) => request.url.endsWith("/api/web_search")));
  } finally {
    mock.restore();
  }
});

test("explicit search request requires evidence even when search ran", async () => {
  const mock = installGateway({ results: [] }, "해당 회사를 확인했습니다.");
  try {
    const { answer } = await answerTurn({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n이 회사에 대해 검색해줘",
      currentTurnText: "이 회사에 대해 검색해줘",
      settings: createSettings(),
    });

    assert.match(answer, /확인 불가/u);
    assert.doesNotMatch(answer, /해당 회사를 확인했습니다/u);
  } finally {
    mock.restore();
  }
});

test("replaces model-authored sources with verified HTTPS citation URLs", async () => {
  const mock = installGateway(
    { results: [{ url: "https://verified.example/rates", title: "Verified", content: "rate evidence" }] },
    "확인한 현재 환율입니다.\n출처:\nhttps://fake.example/rates",
  );
  try {
    const { answer } = await answerTurn({
      question:
        "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST\n\n사용자 질문:\n오늘 원달러 환율 알려줘",
      currentTurnText: "오늘 원달러 환율 알려줘",
      settings: createSettings(),
    });

    assert.doesNotMatch(answer, /fake\.example/u);
    assert.match(answer, /출처: \[Verified\]\(https:\/\/verified\.example\/rates\)/u);
  } finally {
    mock.restore();
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

test("source labels are truncated to 40 characters", async () => {
  const longTitle = "가".repeat(120);
  const answer = await finalizeAnswerForDelivery({
    question: "질문",
    answer: "본문입니다.",
    settings: createSettings({ deliveryRewriteEnabled: false }),
    verifiedCitations: [{ url: "https://long.example/a", title: longTitle }],
  });

  const label = answer.match(/\[([^\]]+)\]\(https:\/\/long\.example\/a\)/u)?.[1];
  assert.equal(label, "가".repeat(40));
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

test("current-information classifier ignores keywords in casual statements", () => {
  const praise =
    "개수만큼 가격차이 나는거라 뭐라고 하진 않아. 그냥 결정장애를 너가 해결해준거야. 잘했어. (쓰담쓰담)";
  assert.equal(isCurrentInformationRequest(praise), false);
  assert.equal(isCurrentInformationRequest("오늘 날씨 좋아서 기분이 좋네"), false);
  assert.equal(isCurrentInformationRequest("요즘 물가 장난 아니야 힘들다"), false);
  assert.equal(isCurrentInformationRequest("교통 지옥이었어 늦어서 미안"), false);
  assert.equal(isCurrentInformationRequest("뉴스 보다가 잠들었어"), false);
  assert.equal(isCurrentInformationRequest("날씨 좋다"), false);
});

test("current-information classifier still catches real questions", () => {
  assert.equal(isCurrentInformationRequest("오늘 환율 얼마야?"), true);
  assert.equal(isCurrentInformationRequest("지금 비트코인 시세 어때?"), true);
  assert.equal(isCurrentInformationRequest("최신 뉴스 뭐 있어?"), true);
  assert.equal(isCurrentInformationRequest("오늘 미세먼지 어떤가요"), true);
  assert.equal(isCurrentInformationRequest("환율 알려주세요"), true);
});

test("request-form detection separates questions from statements", () => {
  assert.equal(isInformationRequestForm("환율 얼마야?"), true);
  assert.equal(isInformationRequestForm("알려줘"), true);
  assert.equal(isInformationRequestForm("뭐라고 하진 않아"), false);
  assert.equal(isInformationRequestForm("잘했어"), false);
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
    const { answer } = await answerTurn({
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
