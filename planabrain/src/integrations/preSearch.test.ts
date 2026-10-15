import assert from "node:assert/strict";
import test from "node:test";

import { answerTurn } from "../chat/webSearchAnswer.js";
import { buildSystemPrompt } from "../config/systemPrompt.js";
import type { Settings } from "../config/settings.js";
import { testSettings } from "../testing/settings.js";
import { codexStream, installFetch, jsonResponse } from "../testing/codex.js";
import { buildSearchQuery, invokeChatWithMetadata, performPreSearch } from "./chat.js";

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
  assert.match(prompt, /출처번호: 1, 3/u);
  assert.match(prompt, /현재 시각과 비교/u);
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
    assert.equal(mock.requests.length, 3);
    assert.equal(mock.requests.filter((request) => request.url.endsWith("/api/web_search")).length, 2);
    assert.equal((mock.requests[2]?.body.input as InputItem[]).length, 1);
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

test("image questions that need search describe the image first and search by its name", async () => {
  const mock = installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) {
      return jsonResponse({ results: [{ title: "플라나 텀블러 가격", url: "https://shop.example/plana", content: "플라나 텀블러 500ml는 19,000원입니다." }] });
    }
    const instructions = String(request.body.instructions ?? "");
    if (instructions.includes("이미지 요약기")) return codexStream("플라나 텀블러 500ml, 흰색 로고");
    if (instructions.includes("웹 검색어 생성기")) return codexStream("{\"query\": \"플라나 텀블러 500ml 가격\"}");
    return codexStream("확인 완료.\n선생님.\n19,000원입니다.\n\n출처: [1]");
  });
  try {
    await answerTurn({
      question: "이거 얼마야?",
      currentTurnText: "이거 얼마야?",
      settings: createSettings({ searchQueryRewriteEnabled: true, deliveryRewriteEnabled: false }),
      images: [{ data: "AAAA", mimeType: "image/png" }],
      signals: { route: "chat", routeConfident: true, currentInfo: true, searchFollowUp: false, socialOnly: false },
    });
    const search = mock.requests.find((request) => request.url.endsWith("/api/web_search"));
    assert.equal(search?.body.query, "플라나 텀블러 500ml 가격");
    const rewrite = mock.codexRequests().find((request) => String(request.body.instructions).includes("웹 검색어 생성기"));
    assert.match(JSON.stringify(rewrite?.body.input), /이미지 내용: 플라나 텀블러 500ml/u);
    const summary = mock.codexRequests().find((request) => String(request.body.instructions).includes("이미지 요약기"));
    assert.match(JSON.stringify(summary?.body.input), /input_image/u);
  } finally {
    mock.restore();
  }
});

test("image questions without search never pay for an image summary", async () => {
  const mock = installFetch(() => codexStream("빨간 원입니다."));
  try {
    await answerTurn({
      question: "이거 뭐야?",
      currentTurnText: "이거 뭐야?",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      images: [{ data: "AAAA", mimeType: "image/png" }],
      signals: { route: "chat", routeConfident: true, currentInfo: false, searchFollowUp: false, socialOnly: false },
    });
    assert.equal(mock.codexRequests().length, 1);
    assert.equal(mock.requests.some((request) => request.url.endsWith("/api/web_search")), false);
  } finally {
    mock.restore();
  }
});

function judged(overrides: Partial<{ currentInfo: boolean; searchFollowUp: boolean; socialOnly: boolean; }>) {
  return { route: "chat" as const, routeConfident: true, currentInfo: false, searchFollowUp: false, socialOnly: false, ...overrides };
}

function searchQueries(mock: ReturnType<typeof installFetch>): unknown[] {
  return mock.requests.filter((request) => request.url.endsWith("/api/web_search")).map((request) => request.body.query);
}

test("social turns never search even when the judge also flags current info", async () => {
  const mock = installGateway();
  try {
    const result = await answerTurn({
      question: "잘자",
      currentTurnText: "프라나야 잘자",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true, socialOnly: true }),
    });
    assert.deepEqual(searchQueries(mock), []);
    assert.doesNotMatch(result.answer, /확인 불가/u);
    assert.doesNotMatch(result.answer, /출처/u);
  } finally {
    mock.restore();
  }
});

test("a judged follow-up only searches when the previous message asked for information", async () => {
  const mock = installGateway();
  try {
    const settings = createSettings({ deliveryRewriteEnabled: false });
    await answerTurn({
      question: "귀여워",
      currentTurnText: "귀여워",
      settings,
      recentTurns: [{ role: "user", text: "프라나야 잘자" }, { role: "assistant", text: "잘 자십시오." }],
      signals: judged({ searchFollowUp: true }),
    });
    assert.deepEqual(searchQueries(mock), []);
    await answerTurn({
      question: "부산은?",
      currentTurnText: "부산은?",
      settings,
      recentTurns: [{ role: "user", text: "대전 날씨 어때?" }, { role: "assistant", text: "대전은 맑습니다." }],
      signals: judged({ searchFollowUp: true }),
    });
    assert.equal(searchQueries(mock).length, 1);
  } finally {
    mock.restore();
  }
});

test("the call name is not part of the search query", async () => {
  const mock = installGateway();
  try {
    await answerTurn({
      question: "대전 날씨 알려줘",
      currentTurnText: "프라나야 대전 날씨 알려줘",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true }),
    });
    assert.deepEqual(searchQueries(mock), ["대전 날씨"]);
  } finally {
    mock.restore();
  }
});

test("statements and hearsay are told apart from questions", async () => {
  const { isStatementTurn } = await import("../chat/queryPolicy.js");
  for (const text of ["심지어 역까지 포르쉐 카이엔으로 데리라온다고함", "내일 비온대", "어제 거기 가봤는데 좋더라", "나 오늘 야근했음", "침대가 10개임"]) {
    assert.equal(isStatementTurn(text), true, text);
  }
  for (const text of ["대전 날씨", "오늘 대전 날씨 어때", "이거 뭐임", "얼마임", "리코 GR4 가격 알려줘", "환율 검색해줘 했음", "비 온대?", "프라나야 부산은"]) {
    assert.equal(isStatementTurn(text), false, text);
  }
});

test("hearsay turns do not search or get blocked even when the judge flags current info", async () => {
  const mock = installGateway();
  try {
    const result = await answerTurn({
      question: "심지어 역까지 포르쉐 카이엔으로 데리라온다고함",
      currentTurnText: "심지어 역까지 포르쉐 카이엔으로 데리라온다고함",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true }),
    });
    assert.deepEqual(searchQueries(mock), []);
    assert.doesNotMatch(result.answer, /확인 불가/u);
  } finally {
    mock.restore();
  }
});

test("a failed search is answered from known facts with one model call", async () => {
  const mock = installGateway({ searchFails: true });
  try {
    const result = await answerTurn({
      question: "대전 날씨",
      currentTurnText: "대전 날씨",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true }),
    });
    assert.doesNotMatch(result.answer, /출처/u);
    assert.equal(mock.codexRequests().length, 1);
    assert.match(String(mock.codexRequests()[0]?.body.instructions), /웹 검색 도구를 사용할 수 없습니다/u);
  } finally {
    mock.restore();
  }
});

test("the replied message is used to write the search query", async () => {
  const mock = installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) return jsonResponse({ results: [] });
    const rewrite = String(request.body.instructions).includes("웹 검색어 생성기");
    return codexStream(rewrite ? '{"query": "갤럭시 Z 폴드8 공개"}' : "확인하지 못했습니다.");
  });
  try {
    await answerTurn({
      question: "메타정보:\n현재 시각: 2026-10-14 (수) 14:00:00 KST\n\n사용자 질문:\n참고 메시지:\n삼성전자가 갤럭시 Z 폴드8을 공개했다\n\n질문:\n이거 진짜야? 검색해줘",
      currentTurnText: "이거 진짜야? 검색해줘",
      settings: createSettings({ searchQueryRewriteEnabled: true, deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true }),
    });
    const rewrite = mock.codexRequests().find((request) => String(request.body.instructions).includes("웹 검색어 생성기"));
    assert.match(JSON.stringify(rewrite?.body.input), /답장한 메시지: 삼성전자가 갤럭시 Z 폴드8을 공개했다/u);
    assert.match(JSON.stringify(rewrite?.body.input), /현재 시각: 2026-10-14 \(수\) 14:00:00 KST/u);
    assert.deepEqual(searchQueries(mock), ["갤럭시 Z 폴드8 공개"]);
  } finally {
    mock.restore();
  }
});

test("a search that fails once on a server error is tried again, but a bad request is not", async () => {
  for (const [status, expected] of [[500, 2], [400, 1]] as const) {
    let searches = 0;
    const mock = installFetch((request) => {
      if (!request.url.endsWith("/api/web_search")) return codexStream("답변입니다.");
      searches += 1;
      return searches === 1 ? jsonResponse({ error: "boom" }, status) : jsonResponse({ results: [{ title: "대전 날씨", url: "https://weather.example/daejeon", content: "맑음" }] });
    });
    try {
      const context = await performPreSearch(createSettings(), "대전 날씨");
      assert.equal(searches, expected);
      assert.equal(Boolean(context), status === 500);
    } finally {
      mock.restore();
    }
  }
});

test("questions about the current date or time are answered without a search", async () => {
  const { isClockQuestion } = await import("../chat/queryPolicy.js");
  for (const text of ["오늘 며칠이야?", "지금 몇 시야", "프라나야 오늘 무슨 요일이야?", "지금 시간 알려줘", "현재 시각은?"]) {
    assert.equal(isClockQuestion(text), true, text);
  }
  for (const text of ["오늘 영업 시간 알려줘", "오늘 날짜에 맞는 운세 알려줘", "지금 미국 대선 상황 어때?"]) {
    assert.equal(isClockQuestion(text), false, text);
  }
  const mock = installGateway();
  try {
    await answerTurn({
      question: "오늘 며칠이야?",
      currentTurnText: "오늘 며칠이야?",
      settings: createSettings({ deliveryRewriteEnabled: false }),
      signals: judged({ currentInfo: true }),
    });
    assert.deepEqual(searchQueries(mock), []);
  } finally {
    mock.restore();
  }
});

test("a judged follow-up is rewritten with the earlier topic before searching", async () => {
  const mock = installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) return jsonResponse({ results: [] });
    const rewrite = String(request.body.instructions).includes("웹 검색어 생성기");
    return codexStream(rewrite ? '{"query": "부산 날씨"}' : "확인하지 못했습니다.");
  });
  try {
    await answerTurn({
      question: "그럼 부산은?",
      currentTurnText: "그럼 부산은?",
      settings: createSettings({ searchQueryRewriteEnabled: true, deliveryRewriteEnabled: false }),
      recentTurns: [{ role: "user", text: "서울 날씨" }, { role: "assistant", text: "서울은 맑습니다." }],
      signals: judged({ currentInfo: true, searchFollowUp: true }),
    });
    assert.deepEqual(searchQueries(mock), ["부산 날씨"]);
  } finally {
    mock.restore();
  }
});

test("a long whitespace-heavy message is not a clock question and is checked quickly", async () => {
  const { isClockQuestion } = await import("../chat/queryPolicy.js");
  const text = `오늘${"\u00a0".repeat(2040)}날짜${"\u00a0".repeat(2040)}x`;
  const startedAt = Date.now();
  assert.equal(isClockQuestion(text), false);
  assert.ok(Date.now() - startedAt < 200);
});

