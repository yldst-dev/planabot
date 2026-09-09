import assert from "node:assert/strict";
import test from "node:test";
import { runExecution, currentExecution, consumeCall, waitForRetry } from "./execution.js";
import { RequestCache } from "../application/requestCache.js";
import { fitContextMessages } from "../chat/contextBudget.js";

test("cancellation stops retry backoff and prevents further calls", async () => {
  const controller = new AbortController();
  await assert.rejects(runExecution("cancel-test", async () => {
    consumeCall();
    controller.abort();
    await waitForRetry(1000);
    consumeCall();
  }, { signal: controller.signal }), { name: "AbortError" });
});

test("nested operations share a budget and expired deadlines reject work", async () => {
  await runExecution("outer", () => runExecution("inner", async () => {
    consumeCall();
    assert.equal(currentExecution()?.calls, 1);
  }));
  let called = false;
  await assert.rejects(runExecution("expired", async () => { called = true; }, { deadlineMs: Date.now() - 1 }), { name: "TimeoutError" });
  assert.equal(called, false);
});

test("request deduplication shares results and rejects conflicting content", async () => {
  const cache = new RequestCache();
  let calls = 0;
  const work = async (): Promise<number> => { calls += 1; return calls; };
  assert.deepEqual(await Promise.all([cache.run("one", "body", work), cache.run("one", "body", work)]), [1, 1]);
  await assert.rejects(cache.run("one", "different", work), /다른 내용/u);
  assert.equal(calls, 1);
});

test("context budgeting keeps the current question and never silently trims replay", () => {
  const messages = [{ role: "system" as const, content: "규칙" }, { role: "user" as const, content: "가".repeat(25_000) }, { role: "assistant" as const, content: "응답" }, { role: "user" as const, content: "현재 질문" }];
  assert.deepEqual(fitContextMessages(messages), [messages[0], messages[3]]);
  assert.throws(() => fitContextMessages(messages, true), /너무 깁니다/u);
  assert.throws(() => fitContextMessages([{ role: "user", content: "가".repeat(25_000) }]), /너무 깁니다/u);
});

test("aborting a queued operation keeps later operations behind the running one", async () => {
  const { serial } = await import("./serial.js");
  let release: () => void = () => { };
  let started: () => void = () => { };
  const running = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = serial("queue-test", async () => { started(); await barrier; });
  await running;
  const controller = new AbortController();
  const second = runExecution("queued", () => serial("queue-test", async () => { assert.fail("cancelled work ran"); }), { signal: controller.signal });
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  await rejected;
  let thirdStarted = false;
  const third = serial("queue-test", async () => { thirdStarted = true; });
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  release();
  await Promise.all([first, third]);
  assert.equal(thirdStarted, true);
});
