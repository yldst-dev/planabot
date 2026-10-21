import assert from "node:assert/strict";
import test from "node:test";

import { interpretScheduleRequest } from "./intent.js";
import { commandAction } from "../cli/commands/schedule.js";

const now = Date.UTC(2026, 9, 14, 5, 0);

function kst(ms: number | undefined): string {
  return new Date((ms ?? 0) + 9 * 3_600_000).toISOString().slice(0, 16);
}

test("rule interpretation ignores questions that only mention schedules", () => {
  for (const text of ["식당 예약 취소하는 방법 알려줘", "알림 끄는 법 알려줘", "2시간 후에 회의인데 준비할 거 알려줘"]) {
    assert.equal(interpretScheduleRequest(text, { nowMs: now }).handled, false, text);
  }
  assert.equal(interpretScheduleRequest("내일 3시 일정 알려줘", { nowMs: now }).action, "list");
});

test("reminders, timers and wake-up requests are registered", () => {
  assert.equal(interpretScheduleRequest("10분 타이머 맞춰줘", { nowMs: now }).kind, "timer");
  assert.equal(interpretScheduleRequest("20분 타이머", { nowMs: now }).action, "add");
  assert.equal(kst(interpretScheduleRequest("30분 있다가 깨워줘", { nowMs: now }).dueAtMs), "2026-10-14T14:30");
  assert.equal(kst(interpretScheduleRequest("내일 아침 7시에 깨워줘", { nowMs: now }).dueAtMs), "2026-10-15T07:00");
});

test("hours without 오전 or 오후 pick the nearest future time and words are not read as weekdays", () => {
  assert.equal(kst(interpretScheduleRequest("3시에 회의 등록해줘", { nowMs: now }).dueAtMs), "2026-10-14T15:00");
  assert.equal(kst(interpretScheduleRequest("오늘 3시에 회의 등록해줘", { nowMs: now }).dueAtMs), "2026-10-14T15:00");
  assert.equal(kst(interpretScheduleRequest("3시 일정 등록해줘", { nowMs: now }).dueAtMs), "2026-10-14T15:00");
  assert.equal(kst(interpretScheduleRequest("3시에 수업 알림 등록해줘", { nowMs: now }).dueAtMs), "2026-10-14T15:00");
  assert.equal(kst(interpretScheduleRequest("낮 2시에 회의 등록해줘", { nowMs: now }).dueAtMs), "2026-10-15T14:00");
  assert.equal(kst(interpretScheduleRequest("다음주 월요일 오전 10시 회의 등록해줘", { nowMs: now }).dueAtMs), "2026-10-19T10:00");
});

test("the judged meridiem resolves hours given without 오전 or 오후", () => {
  assert.equal(kst(interpretScheduleRequest("금요일 3시 회의 등록해줘", { nowMs: now, meridiem: "pm" }).dueAtMs), "2026-10-16T15:00");
  assert.equal(kst(interpretScheduleRequest("3시에 깨워줘", { nowMs: now, meridiem: "am" }).dueAtMs), "2026-10-15T03:00");
  assert.equal(kst(interpretScheduleRequest("금요일 오전 3시 회의 등록해줘", { nowMs: now, meridiem: "pm" }).dueAtMs), "2026-10-16T03:00");
});

test("a decided action overrides keyword detection", () => {
  assert.equal(interpretScheduleRequest("3시에 회의 알려줘", { nowMs: now, action: "add" }).action, "add");
  assert.equal(interpretScheduleRequest("내일 3시 일정 등록된 거 있어?", { nowMs: now, action: "list" }).action, "list");
  assert.equal(interpretScheduleRequest("회의 그거 빼줘", { nowMs: now, action: "cancel" }).target, "회의 그거 빼");
});

test("timers with list words still register and dates are not read as timers", () => {
  const timer = interpretScheduleRequest("10분 물 확인 타이머", { nowMs: now });
  assert.equal(timer.kind, "timer");
  assert.equal(timer.durationMs, 10 * 60_000);
  assert.equal(interpretScheduleRequest("타이머 목록 보여줘", { nowMs: now }).action, "list");
  assert.equal(kst(interpretScheduleRequest("10월 20일 오후 3시 회의 알림 등록해줘", { nowMs: now }).dueAtMs), "2026-10-20T15:00");
  assert.equal(kst(interpretScheduleRequest("25일 오후 3시 알림 등록해줘", { nowMs: now }).dueAtMs), "2026-10-25T15:00");
});

test("half hours, summed timer units, night hours and spaced weeks are read correctly", () => {
  assert.equal(interpretScheduleRequest("1시간 반 뒤에 알려줘", { nowMs: now }).durationMs, 90 * 60_000);
  assert.equal(interpretScheduleRequest("1시간 30분 타이머", { nowMs: now }).durationMs, 90 * 60_000);
  assert.equal(interpretScheduleRequest("1분 30초 타이머", { nowMs: now }).durationMs, 90_000);
  assert.equal(kst(interpretScheduleRequest("오후 3시 반에 회의 알림", { nowMs: now }).dueAtMs), "2026-10-14T15:30");
  assert.equal(kst(interpretScheduleRequest("밤 12시에 알려줘", { nowMs: now }).dueAtMs), "2026-10-15T00:00");
  assert.equal(kst(interpretScheduleRequest("밤 1시에 알림 등록해줘", { nowMs: now }).dueAtMs), "2026-10-15T01:00");
  assert.equal(kst(interpretScheduleRequest("다음 주 금요일 오후 3시 회의 등록해줘", { nowMs: now }).dueAtMs), "2026-10-23T15:00");
});

test("schedule commands register plain text and still list or cancel", () => {
  assert.equal(commandAction("내일 오후 3시 회의 준비"), "add");
  assert.equal(commandAction("목록 타이머"), "list");
  assert.equal(commandAction("1번 취소"), "cancel");
  assert.equal(kst(interpretScheduleRequest("내일 오후 3시 회의 준비", { nowMs: now, action: "add" }).dueAtMs), "2026-10-15T15:00");
});

test("clock minutes stay clock times and invalid dates are refused", () => {
  const oct15 = Date.UTC(2026, 9, 15, 3, 0);
  const at = (text: string, nowMs = oct15) => interpretScheduleRequest(text, { nowMs });
  assert.equal(kst(at("오후 3시 30분 회의 알림 등록해줘").dueAtMs), "2026-10-15T15:30");
  assert.equal(kst(at("금요일 오후 6시 30분 회식 알림 등록").dueAtMs), "2026-10-16T18:30");
  assert.equal(at("오후 2시 10분 타이머 맞춰줘").kind, "schedule");
  assert.equal(at("1시간 30분 타이머").durationMs, 90 * 60_000);
  for (const [text, nowMs] of [["2월 30일 오후 3시 알림 등록해줘", Date.UTC(2027, 0, 10)], ["31일 오후 3시 알림 등록해줘", Date.UTC(2026, 10, 15)], ["2026-13-01 3시 회의 등록해줘", oct15]] as const) {
    assert.equal(at(text, nowMs).error, "시각을 확인하지 못했습니다.", text);
  }
  assert.equal(kst(at("다음 달 5일 오후 3시 회의 등록해줘", Date.UTC(2026, 9, 2)).dueAtMs), "2026-11-05T15:00");
});


test("next month applies only to the day it directly precedes", () => {
  const oct15 = Date.UTC(2026, 9, 15, 3, 0);
  const budget = interpretScheduleRequest("20일 오후 3시 다음 달 예산 회의 등록해줘", { nowMs: oct15 });
  assert.equal(kst(budget.dueAtMs), "2026-10-20T15:00");
  assert.equal(budget.title, "다음 달 예산 회의");
  assert.equal(kst(interpretScheduleRequest("다음 달 계획 회의 20일 오후 3시 등록해줘", { nowMs: oct15 }).dueAtMs), "2026-10-20T15:00");
  assert.equal(kst(interpretScheduleRequest("다다음 달 20일 오후 3시 회의 등록해줘", { nowMs: oct15 }).dueAtMs), "2026-12-20T15:00");
});

test("leap days roll forward, unreadable dates are refused and minutes before an hour count back", () => {
  const oct15 = Date.UTC(2026, 9, 15, 3, 0);
  assert.equal(kst(interpretScheduleRequest("2월 29일 오후 3시 알림 등록해줘", { nowMs: Date.UTC(2027, 2, 1, 3) }).dueAtMs), "2028-02-29T15:00");
  for (const text of ["말일 오후 3시 알림 등록해줘", "10/20 오후 3시 회의 등록해줘", "2026. 10. 20. 오후 3시 회의 등록해줘", "다음 달 오후 3시 회의 등록해줘"]) {
    assert.equal(interpretScheduleRequest(text, { nowMs: oct15 }).error, "시각을 확인하지 못했습니다.", text);
  }
  assert.equal(kst(interpretScheduleRequest("3시 10분 전에 알림 등록해줘", { nowMs: oct15 }).dueAtMs), "2026-10-15T14:50");
});

test("phone numbers, years and fractions before a clock time are not read as dates", () => {
  const oct15 = Date.UTC(2026, 9, 15, 3, 0);
  for (const [text, title] of [
    ["010-1234-5678 오후 3시 전화 알림 등록해줘", "010-1234-5678 전화"],
    ["2026년 사업계획 회의 오후 3시 등록해줘", "2026년 사업계획 회의"],
    ["2026년도 예산 회의 오후 3시 등록해줘", "2026년도 예산 회의"],
    ["1/2 정산 회의 오후 3시 등록해줘", "1/2 정산 회의"],
  ] as const) {
    const result = interpretScheduleRequest(text, { nowMs: oct15 });
    assert.equal(kst(result.dueAtMs), "2026-10-15T15:00", text);
    assert.equal(result.title, title, text);
  }
});

test("other unread dates and repeating requests are refused instead of landing today", () => {
  const oct15 = Date.UTC(2026, 9, 15, 3, 0);
  for (const text of ["10.20 오후 3시 회의 등록해줘", "10-20 오후 3시 회의 등록해줘", "10. 20. 오후 3시 회의 등록해줘", "다음 달 말 오후 3시 회의 등록해줘", "다음 주말 오후 3시 등산 등록해줘", "다음 달 첫째 주 월요일 오후 3시 회의 등록해줘"]) {
    assert.equal(interpretScheduleRequest(text, { nowMs: oct15 }).error, "시각을 확인하지 못했습니다.", text);
  }
  for (const text of ["매일 오후 3시 알림 등록해줘", "매주 월요일 오전 9시 회의 등록해줘", "평일마다 오전 8시 알림 등록해줘", "10분마다 물 마시기 알림"]) {
    assert.equal(interpretScheduleRequest(text, { nowMs: oct15 }).error, "반복 일정은 아직 지원하지 않습니다.", text);
  }
});

test("minutes before a later clock time count back while floors, headcounts and quarters stay out of the time", () => {
  const morning = Date.UTC(2026, 9, 15, 1, 0);
  const at = (text: string) => interpretScheduleRequest(text, { nowMs: morning });
  const before = at("오후 3시 회의 10분 전에 알림 등록해줘");
  assert.equal(kst(before.dueAtMs), "2026-10-15T14:50");
  assert.equal(before.title, "회의");
  assert.equal(at("회의 10분 전에 알림 등록해줘").error, "시각을 확인하지 못했습니다.");
  for (const text of ["4분기 실적 발표 오후 3시 알림 등록해줘", "오후 3시 3층 회의실 회의 등록해줘", "오후 3시 20명 회의 등록해줘"]) {
    assert.equal(kst(at(text).dueAtMs), "2026-10-15T15:00", text);
  }
  assert.equal(kst(at("정오에 점심 알림 등록해줘").dueAtMs), "2026-10-15T12:00");
  assert.equal(kst(at("자정에 알림 등록해줘").dueAtMs), "2026-10-16T00:00");
});

test("noon words, bare minutes, repeat words, score pairs and date words in titles are read as whole words", () => {
  const morning = Date.UTC(2026, 9, 15, 1, 0);
  const at = (text: string) => interpretScheduleRequest(text, { nowMs: morning });
  for (const [text, due, title] of [
    ["사용자정보 변경 오후 3시 알림 등록해줘", "2026-10-15T15:00", "사용자정보 변경"],
    ["매일경제 인터뷰 내일 오후 3시 등록해줘", "2026-10-16T15:00", "매일경제 인터뷰"],
    ["1-1 미팅 오후 3시 등록해줘", "2026-10-15T15:00", "1-1 미팅"],
    ["내일배움카드 신청 내일 오후 3시 알림 등록해줘", "2026-10-16T15:00", "내일배움카드 신청"],
    ["오늘의집 배송 오늘 오후 3시 알림 등록해줘", "2026-10-15T15:00", "오늘의집 배송"],
  ] as const) {
    const result = at(text);
    assert.equal(kst(result.dueAtMs), due, text);
    assert.equal(result.title, title, text);
  }
  assert.equal(kst(at("오후 3시 30부터 회의 등록해줘").dueAtMs), "2026-10-15T15:30");
  assert.equal(at("2/4 오후 3시 회의 등록해줘").error, "시각을 확인하지 못했습니다.");
});

test("spaced repeat words, noon words with particles or date words, hour ranges and date words before the time are read", () => {
  const morning = Date.UTC(2026, 9, 15, 1, 0);
  const at = (text: string) => interpretScheduleRequest(text, { nowMs: morning });
  for (const text of ["평일 마다 오전 8시 알림 등록해줘", "10분 마다 알림 등록해줘", "알림매일 오전 7시 등록해줘"]) {
    assert.equal(at(text).error, "반복 일정은 아직 지원하지 않습니다.", text);
  }
  for (const [text, due] of [
    ["회의를 정오로 등록해줘", "2026-10-15T12:00"],
    ["자정으로 알림 맞춰줘", "2026-10-16T00:00"],
    ["오늘자정까지 보고서 알림 등록해줘", "2026-10-16T00:00"],
    ["금요일정오에 회의 등록해줘", "2026-10-16T12:00"],
    ["공정오류 확인 오후 3시 알림 등록해줘", "2026-10-15T15:00"],
    ["오후 3시 1~2시간 회의 등록해줘", "2026-10-15T15:00"],
    ["오늘은 밤 11시 내일 준비물 챙기기 알림 등록해줘", "2026-10-15T23:00"],
    ["내일은 오후 7시 오늘 못 본 드라마 보기 알림 등록해줘", "2026-10-16T19:00"],
  ] as const) {
    assert.equal(kst(at(text).dueAtMs), due, text);
  }
});

test("words that contain 자정, 정오 or 마다 and date words glued to other syllables keep the stated time and date", () => {
  const morning = Date.UTC(2026, 9, 15, 1, 0);
  for (const [text, due] of [
    ["하천 자정과정 보고서 오후 3시 알림 등록해줘", "2026-10-15T15:00"],
    ["업계 자정과 혁신 세미나 오후 3시 알림 등록해줘", "2026-10-15T15:00"],
    ["정오와 오류 검토 오후 3시 알림 등록해줘", "2026-10-15T15:00"],
    ["수고를 마다하지 않는 팀 회식 오후 7시 등록해줘", "2026-10-15T19:00"],
    ["궂은일 마다않고 도와준 동료 점심 오후 1시 등록해줘", "2026-10-15T13:00"],
    ["오늘의 운세 확인 오전 8시 내일 알림 등록해줘", "2026-10-16T08:00"],
    ["오늘의집 주문 오후 3시 내일 알림 등록해줘", "2026-10-16T15:00"],
    ["내일의 회의 오후 3시 알림 등록해줘", "2026-10-16T15:00"],
  ] as const) {
    assert.equal(kst(interpretScheduleRequest(text, { nowMs: morning }).dueAtMs), due, text);
  }
});

test("rule parsing skips user text far longer than any command", () => {
  const started = performance.now();
  assert.equal(interpretScheduleRequest(`오후 3시 ${"1".repeat(50_000)} 알림`).handled, false);
  assert.equal(interpretScheduleRequest(`${"일정 ".repeat(1_000)}보여줘`, { action: "list" }).action, "list");
  assert.ok(performance.now() - started < 1_000);
});
