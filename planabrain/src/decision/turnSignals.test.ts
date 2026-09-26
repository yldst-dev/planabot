import assert from "node:assert/strict";
import test from "node:test";
import { classifyTurn, parseTurnSignals } from "./turnSignals.js";
import { loadDecisionConfig } from "./config.js";

const config = { apiKey: "test-key", baseUrl: "https://decision.example/api", model: "typesafe/jev-1.13", timeoutMs: 1000 };

function mockFetch(reply: (body: Record<string, unknown>, url: string) => Response): { requests: Array<{ url: string; body: Record<string, unknown>; }>; restore: () => void; } {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown>; }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body });
    return reply(body, String(input));
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

function answers(values: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: values }), { status: 200, headers: { "content-type": "application/json" } });
}

test("one call returns every turn signal with thresholds applied", async () => {
  const mock = mockFetch(() => answers({
    route: { type: "choice", choice: "todo_complete", confidence: 0.92 },
    current_info: { type: "noul", noul: 0.65 },
    social: { type: "noul", noul: 0.85 },
    follow_up: { type: "noul", noul: 0.9 },
  }));
  try {
    const result = await classifyTurn({ message: "보고서 작성 완료 처리해줘", previousUserMessage: "할 일 보여줘" }, config);
    assert.deepEqual(result?.signals, { route: "todo_complete", routeConfident: true, currentInfo: false, searchFollowUp: true, socialOnly: true });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, "https://decision.example/api/v1/systemone");
    assert.deepEqual(Object.keys(mock.requests[0].body.questions as object).sort(), ["current_info", "follow_up", "route", "social"]);
    assert.deepEqual(mock.requests[0].body.state, { previous_user_message: "할 일 보여줘", last_user_message: "보고서 작성 완료 처리해줘" });
  } finally { mock.restore(); }
});

test("follow-up question is skipped without a previous user message", async () => {
  const mock = mockFetch(() => answers({
    route: { type: "choice", choice: "chat", confidence: 0.4 },
    current_info: { type: "noul", noul: 0.95 },
    social: { type: "noul", noul: 0.1 },
  }));
  try {
    const result = await classifyTurn({ message: "오늘 환율 얼마야?" }, config);
    assert.equal(result?.signals.routeConfident, false);
    assert.equal(result?.signals.currentInfo, true);
    assert.equal(result?.signals.searchFollowUp, false);
    assert.equal("follow_up" in (mock.requests[0].body.questions as object), false);
  } finally { mock.restore(); }
});

test("memory candidates become relevance questions in the same call", async () => {
  const mock = mockFetch(() => answers({
    route: { type: "choice", choice: "chat", confidence: 0.9 },
    current_info: { type: "noul", noul: 0.1 },
    social: { type: "noul", noul: 0.1 },
    memory_3: { type: "noul", noul: 0.81 },
    memory_9: { type: "noul", noul: 0.2 },
  }));
  try {
    const result = await classifyTurn({ message: "떡볶이 어때?", memories: [{ id: 3, content: "사용자는 매운 음식을 못 먹는다" }, { id: 9, content: "사용자는 부산에 산다" }] }, config);
    assert.deepEqual([...(result?.relevantMemoryIds ?? [])], [3]);
    assert.equal(mock.requests.length, 1);
    assert.match(JSON.stringify(mock.requests[0].body.questions), /매운 음식/u);
  } finally { mock.restore(); }
});

test("provider errors and malformed answers fall back to rule decisions", async () => {
  for (const response of [
    () => new Response("overloaded", { status: 529 }),
    () => answers({ route: { type: "choice", choice: "unknown_route", confidence: 1 }, current_info: { type: "noul", noul: 0.1 }, social: { type: "noul", noul: 0.1 } }),
    () => answers({ route: { type: "choice", choice: "chat", confidence: 1 }, current_info: { type: "noul", noul: 3 }, social: { type: "noul", noul: 0.1 } }),
  ]) {
    const mock = mockFetch(response);
    try {
      assert.equal(await classifyTurn({ message: "안녕" }, config), undefined);
    } finally { mock.restore(); }
  }
});

test("classification is skipped when the decision provider is off", async () => {
  const mock = mockFetch(() => { throw new Error("must not call"); });
  try {
    assert.equal(await classifyTurn({ message: "안녕" }, undefined), undefined);
    assert.equal(mock.requests.length, 0);
  } finally { mock.restore(); }
});

test("decision config is opt-in and reuses the OpenRouter key", () => {
  assert.equal(loadDecisionConfig({ OPENROUTER_API_KEY: "key" }), undefined);
  assert.equal(loadDecisionConfig({ PLANABRAIN_DECISION_PROVIDER: "jev" }), undefined);
  assert.deepEqual(loadDecisionConfig({ PLANABRAIN_DECISION_PROVIDER: "jev", OPENROUTER_API_KEY: "key", PLANABRAIN_DECISION_BASE_URL: "https://gw.example/api/" }), {
    apiKey: "key",
    baseUrl: "https://gw.example/api",
    model: "typesafe/jev-1.13",
    timeoutMs: 2500,
  });
});

test("forwarded signals are validated before use", () => {
  assert.deepEqual(parseTurnSignals({ route: "chat", routeConfident: true, currentInfo: true, searchFollowUp: false, socialOnly: false }), { route: "chat", routeConfident: true, currentInfo: true, searchFollowUp: false, socialOnly: false });
  assert.equal(parseTurnSignals({ route: "shell", routeConfident: true, currentInfo: true, searchFollowUp: false, socialOnly: false }), undefined);
  assert.equal(parseTurnSignals({ route: "chat", currentInfo: "yes" }), undefined);
  assert.equal(parseTurnSignals(null), undefined);
});
