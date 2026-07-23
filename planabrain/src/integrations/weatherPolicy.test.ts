import assert from "node:assert/strict";
import test from "node:test";

import { buildLongRangeWeatherReply } from "../chat/weatherPolicy.js";

const METADATA = "메타정보:\n현재 시각: 2026-07-24 (금) 02:08:00 KST";

test("blocks weather requests beyond the forecast horizon", () => {
  const result = buildLongRangeWeatherReply(
    "삿포로의 2026년 8월 말 날씨를 알려줘",
    METADATA,
  );

  assert.match(result ?? "", /단기 예보 범위를 벗어납니다/u);
  assert.match(result ?? "", /정확한 날씨로 단정할 수 없습니다/u);
});

test("allows weather requests within the forecast horizon", () => {
  const result = buildLongRangeWeatherReply(
    "삿포로의 2026년 7월 30일 날씨를 알려줘",
    METADATA,
  );

  assert.equal(result, null);
});

test("allows explicit climate information requests", () => {
  const result = buildLongRangeWeatherReply(
    "삿포로의 2026년 8월 말 평년 기후와 평균 기온을 알려줘",
    METADATA,
  );

  assert.equal(result, null);
});

test("does not treat casual conversation as a weather request", () => {
  const result = buildLongRangeWeatherReply("심심해", METADATA);

  assert.equal(result, null);
});

test("infers the next year for a past month without an explicit year", () => {
  const result = buildLongRangeWeatherReply("1월 말 날씨를 알려줘", METADATA);

  assert.match(result ?? "", /단기 예보 범위를 벗어납니다/u);
});
