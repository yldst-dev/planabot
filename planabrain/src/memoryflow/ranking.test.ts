import assert from "node:assert/strict";
import test from "node:test";

import { embedText } from "./embedding.js";
import { buildContextBundle } from "./ranking.js";

const weatherEpisode = {
  id: "episode-weather",
  text: "삿포로 2026년 8월 말 날씨",
  at: 1_000,
  salience: 1,
  embedding: embedText("삿포로 2026년 8월 말 날씨")
};

const weatherSummary = {
  id: "summary-weather",
  text: "8월 말 삿포로 기후 정보",
  fromTurnId: "turn-1",
  toTurnId: "turn-2",
  at: 1_000,
  salience: 1,
  embedding: embedText("8월 말 삿포로 기후 정보")
};

test("unrelated episodic and summary memories are excluded", () => {
  const bundle = buildContextBundle({
    query: "심심해",
    tokenBudget: 900,
    semanticFacts: [],
    episodicItems: [weatherEpisode],
    summaryItems: [weatherSummary],
    workingTurns: [],
    now: 1_000
  });

  assert.equal(bundle.contextText, "memory_context: none");
});

test("related episodic and summary memories remain available", () => {
  const bundle = buildContextBundle({
    query: "삿포로 날씨",
    tokenBudget: 900,
    semanticFacts: [],
    episodicItems: [weatherEpisode],
    summaryItems: [weatherSummary],
    workingTurns: [],
    now: 1_000
  });

  assert.match(bundle.contextText, /삿포로 2026년 8월 말 날씨/u);
  assert.match(bundle.contextText, /8월 말 삿포로 기후 정보/u);
});
