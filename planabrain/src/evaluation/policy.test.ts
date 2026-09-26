import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentInformationRequest, isExplicitSearchRequest, isSearchFollowUp } from "../chat/queryPolicy.js";
import { fallbackRelevant } from "../memory/recall.js";
import type { MemoryRecord } from "../memory/types.js";

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

const memories: MemoryRecord[] = [
  { id: 1, content: "사용자는 8월 말에 삿포로 여행을 간다" },
  { id: 2, content: "사용자는 봇 프로젝트의 배포 작업을 진행 중이다" },
].map((entry) => ({ ...entry, subjectUserId: "u1", chatId: "chat_u1", direct: true, kind: "plan", importance: 0.6, createdAt: 1000, updatedAt: 1000, lastRecalledAt: null }));

for (const entry of [
  { question: "삿포로 여행 일정", expected: 1 },
  { question: "봇 프로젝트 배포", expected: 2 },
  { question: "심심해", expected: undefined },
]) {
  test(`Korean memory fallback recall: ${entry.question}`, () => {
    const recalled = fallbackRelevant(memories, entry.question);
    if (entry.expected) assert.equal(recalled[0]?.id, entry.expected); else assert.equal(recalled.length, 0);
  });
}
