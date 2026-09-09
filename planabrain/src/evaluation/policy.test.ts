import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentInformationRequest, isExplicitSearchRequest, isSearchFollowUp } from "../chat/queryPolicy.js";
import { buildContextBundle } from "../memoryflow/ranking.js";
import { embedText } from "../memoryflow/embedding.js";

const searchCases = [
  { question: "오늘 서울 날씨 알려줘", required: true },
  { question: "현재 환율 얼마야?", required: true },
  { question: "이번 주 경기 일정 알려줘", required: true },
  { question: "이 회사에 대해 검색해줘", required: true },
  { question: "안녕 프라나", required: false },
  { question: "오늘 기분이 좋아", required: false },
  { question: "반복문을 설명해줘", required: false },
  { question: "날씨가 좋네", required: false },
];

for (const entry of searchCases) {
  test(`Korean search policy: ${entry.question}`, () => {
    assert.equal(isCurrentInformationRequest(entry.question) || isExplicitSearchRequest(entry.question), entry.required);
  });
}

for (const entry of [
  { question: "그럼 부산은?", expected: true },
  { question: "아니, 서울 말고 대전", expected: true },
  { question: "2027년이었어", expected: true },
  { question: "고마워", expected: false },
  { question: "파이썬 함수를 설명해줘", expected: false },
  { question: "심심해", expected: false },
]) {
  test(`Korean search follow-up: ${entry.question}`, () => {
    assert.equal(isSearchFollowUp("오늘 서울 날씨 알려줘", entry.question), entry.expected);
  });
}

const episodes = [
  { id: "travel", text: "삿포로 여행 일정은 8월 말입니다", at: 1000, salience: 0.8 },
  { id: "project", text: "봇 프로젝트의 배포 작업을 진행합니다", at: 1000, salience: 0.8 },
].map((entry) => ({ ...entry, embedding: embedText(entry.text) }));

for (const entry of [
  { question: "삿포로 여행 일정", expected: "travel" },
  { question: "봇 프로젝트 배포", expected: "project" },
  { question: "심심해", expected: undefined },
]) {
  test(`Korean memory retrieval: ${entry.question}`, () => {
    const bundle = buildContextBundle({ query: entry.question, tokenBudget: 900, semanticFacts: [], episodicItems: episodes, summaryItems: [], workingTurns: [], now: 1000 });
    const ranked = bundle.sections.flatMap((section) => section.items);
    if (entry.expected) assert.equal(ranked[0]?.id, entry.expected); else assert.equal(ranked.length, 0);
    assert.ok(bundle.estimatedTokens <= 900);
  });
}
