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
