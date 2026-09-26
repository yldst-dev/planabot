import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import { testSettings } from "../testing/settings.js";
import { codexStream, installFetch, jsonResponse, type CapturedRequest } from "../testing/codex.js";
import { buildChatSystemPrompt } from "./replay.js";
import {
  answerTurn,
  applySourceSelection,
  buildReplay,
  isSearchFollowUp,
  parseRewrittenQuery,
  type RecentTurnInput,
} from "./webSearchAnswer.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings(overrides);
}

type InputItem = { role: string; content: string; };

function installGateway(handlers: {
  rewrite?: string;
  search?: unknown;
  answer: string;
}): ReturnType<typeof installFetch> {
  let chatCalls = 0;
  return installFetch((request) => {
    if (request.url.endsWith("/api/web_search")) {
      return jsonResponse(handlers.search ?? { results: [] });
    }
    chatCalls += 1;
    return codexStream(chatCalls === 1 && handlers.rewrite !== undefined ? handlers.rewrite : handlers.answer);
  });
}

function inputOf(request: CapturedRequest | undefined): InputItem[] {
  return (request?.body.input ?? []) as InputItem[];
}

const searchResults = {
  results: [
    { title: "TETRAPOD 2026 취소 공지", url: "https://fest.example/notice", content: "주최 측이 취소를 알렸습니다." },
    { title: "다른 페스티벌 소식", url: "https://other.example/news", content: "무관한 내용" },
    { title: "세 번째 결과", url: "https://third.example/a", content: "세 번째" },
  ],
};

test("continuous mode replays canonical turns and records the delivered answer", async () => {
  const settings = createSettings({ searchQueryRewriteEnabled: false });
  const recentTurns: RecentTurnInput[] = [
    { role: "user", text: "안녕", at: 1, epoch: 0 },
    {
      role: "assistant",
      text: "안녕하세요.",
      at: 2,
      epoch: 0,
      wireMessages: [
        { role: "user", content: "메타정보\n\n안녕" },
        { role: "assistant", content: "안녕하세요, 선생님." },
      ],
    },
  ];
  const mock = installGateway({ answer: "잘 지냈습니다." });
  try {
    const result = await answerTurn({
      question: "잘 지냈어?",
      currentTurnText: "잘 지냈어?",
      settings,
      userId: "u1",
      recentTurns,
      memoryContext: "memory_context:\n- 선생님은 커피를 좋아함",
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0]?.body.instructions, buildChatSystemPrompt(settings));
    const input = inputOf(mock.requests[0]);
    assert.deepEqual(input.slice(0, 2), [
      { role: "user", content: "안녕" },
      { role: "assistant", content: "안녕하세요." },
    ]);
    assert.equal(input.length, 4);
    assert.match(input[2]!.content, /PAST_MEMORY_DATA_BEGIN/u);
    assert.equal(input[3]!.content, "잘 지냈어?");
    assert.equal(result.answer, "잘 지냈습니다.");
    assert.ok(result.transcript);
    assert.equal(result.transcript?.epoch, 0);
    assert.deepEqual(result.transcript?.wireMessages, [
      { role: "user", content: "잘 지냈어?" },
      { role: "assistant", content: "잘 지냈습니다." },
    ]);
  } finally {
    mock.restore();
  }
});

test("standalone search skips query rewriting and keeps only selected sources", async () => {
  const settings = createSettings({ auxModel: "fast-model" });
  const mock = installGateway({
    search: searchResults,
    answer: "확인 완료.\n선생님.\nTETRAPOD 2026은 주최 측 사정으로 취소됐습니다.\n출처번호: 1",
  });
  try {
    const result = await answerTurn({
      question: "테트라포트 2026이 취소됐다는데 진짜인지 알아봐줘",
      currentTurnText: "테트라포트 2026이 취소됐다는데 진짜인지 알아봐줘",
      settings,
      userId: "u1",
      recentTurns: [],
    });
    const search = mock.requests.find((r) => r.url.endsWith("/api/web_search"));
    assert.equal(search?.body.query, "테트라포트 2026이 취소됐다는데 진짜인지");
    const chats = mock.codexRequests();
    assert.equal(chats.length, 1);
    assert.equal(chats[0]?.body.model, settings.chatModel);
    assert.ok(inputOf(chats[0]).some((message) => message.content.includes("[웹 검색 결과]")));
    assert.doesNotMatch(result.answer, /출처번호/u);
    assert.match(result.answer, /출처: \[TETRAPOD 2026 취소 공지\]\(https:\/\/fest\.example\/notice\)/u);
    assert.doesNotMatch(result.answer, /other\.example/u);
  } finally {
    mock.restore();
  }
});

test("short corrections after a search question trigger a contextual search", async () => {
  const settings = createSettings();
  const mock = installGateway({
    rewrite: "{\"query\": \"TETRAPOD 2026 취소\"}",
    search: searchResults,
    answer: "확인 완료.\n선생님.\n취소가 맞습니다.\n출처번호: 1",
  });
  try {
    const result = await answerTurn({
      question: "TETRAPOD 2026 이었어",
      currentTurnText: "TETRAPOD 2026 이었어",
      settings,
      userId: "u1",
      recentTurns: [
        { role: "user", text: "테트라포트 2026이 취소됐다는데 진짜인지 알아봐줘", at: 1 },
        { role: "assistant", text: "확인할 수 없습니다.", at: 2 },
      ],
    });
    assert.ok(mock.requests.some((r) => r.url.endsWith("/api/web_search")));
    assert.match(result.answer, /취소가 맞습니다/u);
    assert.match(result.answer, /fest\.example/u);
  } finally {
    mock.restore();
  }
});

test("canonical replay drops the oldest pair without discarding recent context", async () => {
  const settings = createSettings({ searchQueryRewriteEnabled: false });
  const exchange = (index: number, epoch: number): RecentTurnInput[] => [
    { role: "user", text: `q${index}`, at: index * 2, epoch },
    {
      role: "assistant",
      text: `a${index}`,
      at: index * 2 + 1,
      epoch,
      wireMessages: [
        { role: "user", content: `wire q${index}` },
        { role: "assistant", content: `a${index}` },
      ],
    },
  ];
  const mock = installGateway({ answer: "다음 답변" });
  try {
    const kept = await answerTurn({
      question: "q2",
      currentTurnText: "q2",
      settings,
      userId: "u1",
      recentTurns: exchange(1, 0),
      workingTurnLimit: 4,
    });
    assert.equal(kept.transcript?.epoch, 0);
    assert.equal(inputOf(mock.requests[0]).length, 3);
    const reset = await answerTurn({
      question: "q3",
      currentTurnText: "q3",
      settings,
      userId: "u1",
      recentTurns: [...exchange(1, 0), ...exchange(2, 0)],
      workingTurnLimit: 4,
    });
    assert.equal(reset.transcript?.epoch, 0);
    assert.equal(inputOf(mock.requests[1]).length, 3);
    assert.equal(inputOf(mock.requests[1])[0]?.content, "q2");
  } finally {
    mock.restore();
  }
});

test("replay keeps only the latest epoch", () => {
  const older = buildReplay([
    { role: "user", text: "old", epoch: 1 },
    { role: "assistant", text: "old answer", epoch: 1 },
    { role: "user", text: "new", epoch: 2 },
    { role: "assistant", text: "new answer", epoch: 2 },
  ]);
  assert.equal(older.epoch, 2);
  assert.deepEqual(older.messages.map((m) => m.content), ["new", "new answer"]);
});

test("source selection line filters citations and is removed from the answer", () => {
  const citations = [
    { url: "https://a.example/1", title: "A" },
    { url: "https://b.example/2", title: "B" },
    { url: "https://c.example/3", title: "C" },
    { url: "https://d.example/4", title: "D" },
  ];
  const picked = applySourceSelection("본문\n출처번호: 2, 4", citations);
  assert.equal(picked.content, "본문");
  assert.deepEqual(picked.citations.map((c) => c.url), ["https://b.example/2", "https://d.example/4"]);
  const none = applySourceSelection("본문\n출처번호: 없음", citations);
  assert.deepEqual(none.citations, []);
  const fallback = applySourceSelection("본문만", citations);
  assert.equal(fallback.citations.length, 3);
});

test("follow-up detection and query parsing", () => {
  assert.equal(isSearchFollowUp("대전 날씨 알아봐줘", "TETRAPOD 2026 이었어"), true);
  assert.equal(isSearchFollowUp("대전 날씨 알아봐줘", "고마워"), false);
  assert.equal(isSearchFollowUp("안녕 프라나", "TETRAPOD 2026 이었어"), false);
  assert.equal(isSearchFollowUp(undefined, "뭐야"), false);
  assert.equal(parseRewrittenQuery("{\"query\": \"대전 날씨\"}"), "대전 날씨");
  assert.equal(parseRewrittenQuery("설명 {\"query\": null} 끝"), null);
  assert.equal(parseRewrittenQuery("no json"), undefined);
});
