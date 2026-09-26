import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnMessages, buildMemoryContextMessage } from "./promptContext.js";
import { fitContextMessages, contextTokens } from "./contextBudget.js";
import { buildReplay } from "./replay.js";
import { normalizeDeliveryText, finalizeAnswerForDelivery } from "./deliveryRewrite.js";
import { invokeChatWithMetadata } from "../integrations/chat.js";
import { testSettings } from "../testing/settings.js";
import { codexStream, installFetch } from "../testing/codex.js";
import { runExecution } from "../runtime/execution.js";
import type { ChatMessage } from "../integrations/contracts.js";

const parts = {
  systemContent: "시스템 규칙",
  history: [] as ChatMessage[],
  referenceContext: null,
  memoryContext: null,
  linkContext: null,
  searchContext: null,
  currentTurnText: "현재 질문",
};

test("budgeting protects current evidence and reference after dropping old pairs", () => {
  const messages = buildTurnMessages({
    ...parts,
    history: [{ role: "user", content: "가".repeat(25_000) }, { role: "assistant", content: "이전 답변" }],
    referenceContext: "답장한 원문",
    searchContext: "현재 검색 근거",
  });
  assert.deepEqual(messages.map((message) => message.content), ["시스템 규칙", "답장한 원문", "현재 검색 근거", "현재 질문"]);
  assert.throws(() => buildTurnMessages({ ...parts, searchContext: "가".repeat(25_000) }), /너무 깁니다/u);
  assert.throws(() => fitContextMessages([{ role: "user", content: "질문" }, { role: "developer", content: "가".repeat(25_000) }]), /너무 깁니다/u);
});

test("memory deduplication preserves other speakers and facts when history was evicted", () => {
  const memory = buildMemoryContextMessage("memory_context:\nworking:\n- user: 여행 날짜는 10월 3일\n- user(other): 여행 날짜는 10월 3일\n- assistant: 확인했습니다.\nsemantic:\n- trip=10월 4일");
  const messages = buildTurnMessages({ ...parts, memoryContext: memory, history: [{ role: "user", content: "여행 날짜는 10월 3일" }, { role: "assistant", content: "확인했습니다." }] });
  const retained = messages.find((message) => message.contextKind === "memory")?.content ?? "";
  assert.doesNotMatch(retained, /- user: 여행/u);
  assert.doesNotMatch(retained, /- assistant: 확인/u);
  assert.match(retained, /user\(other\)/u);
  assert.match(retained, /10월 4일/u);
  const large = "가".repeat(25_000);
  const evicted = buildTurnMessages({ ...parts, memoryContext: buildMemoryContextMessage("memory_context:\n- assistant: 확인했습니다."), history: [{ role: "user", content: large }, { role: "assistant", content: "확인했습니다." }] });
  assert.match(evicted.find((message) => message.contextKind === "memory")?.content ?? "", /확인했습니다/u);
});

test("canonical replay avoids accumulated evidence and preserves delivered wording", () => {
  const turns = [
    { role: "user" as const, text: "안녕", epoch: 1 },
    { role: "assistant" as const, text: "선생님.\n안녕하세요.", epoch: 1, wireMessages: [{ role: "user" as const, content: "검색 본문".repeat(1000) }, { role: "assistant" as const, content: "잘못된 원문" }] },
  ];
  const canonical = buildReplay(turns);
  assert.deepEqual(canonical.messages.map((message) => message.content), ["안녕", "선생님.\n안녕하세요."]);
  assert.ok(contextTokens(canonical.messages) < contextTokens(turns[1]?.wireMessages?.map((wire) => ({ role: wire.role, content: wire.content })) ?? []) / 10);
});

test("delivery formatting is idempotent and preserves numbers and sentence meaning", () => {
  const formatted = normalizeDeliveryText("네, 선생님.\n\n가격은 519MB가 아니라 519원입니다. 날짜는 2026-09-14입니다.");
  assert.match(formatted, /^네\.\n선생님\./u);
  assert.match(formatted, /519MB가 아니라 519원/u);
  assert.match(formatted, /2026-09-14/u);
  assert.equal(normalizeDeliveryText(formatted), formatted);
});

test("continuations record the complete sanitized answer instead of its last fragment", async () => {
  const mock = installFetch((_request, index) => codexStream(index === 1 ? "첫 문장." : "다음 문장.", { incomplete: index === 1 }));
  try {
    const result = await invokeChatWithMetadata({ settings: testSettings(), messages: [{ role: "user", content: "설명해줘" }] });
    assert.equal(mock.requests.length, 2);
    assert.equal(result.wireMessages.at(-1)?.content, result.content);
    assert.match(result.content, /첫 문장/u);
    assert.match(result.content, /다음 문장/u);
  } finally { mock.restore(); }
});

test("short answers and verified sources do not trigger an auxiliary rewrite", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected call"); }) as typeof fetch;
  try {
    const answer = await finalizeAnswerForDelivery({ settings: testSettings({ deliveryRewriteEnabled: true }), question: "좋은 밤이야", answer: "선생님.\n좋은 밤입니다." });
    assert.equal(answer, "선생님.\n좋은 밤입니다.");
  } finally { globalThis.fetch = original; }
});

test("canonical replay retains the delivered answer when long-term memory was summarized", () => {
  const replay = buildReplay([
    { role: "user", text: "어제 확인한 날씨는?", ownerUserId: "participant-a" },
    { role: "assistant", text: "시의성 정보 확인 응답 완료.", wireMessages: [{ role: "user", content: "어제 확인한 날씨는?" }, { role: "assistant", content: "선생님.\n당시 확인한 기온은 20도였습니다." }] },
  ]);
  assert.match(replay.messages[0].content, /participant-a/u);
  assert.match(replay.messages[1].content, /20도/u);
});

test("exhausted retry budgets return the original upstream failure without another call", async () => {
  const { withRateLimitRetry } = await import("../integrations/retry.js");
  const { ProviderApiError } = await import("../integrations/providerError.js");
  const { consumeCall } = await import("../runtime/execution.js");
  const original = new ProviderApiError({ kind: "rate_limited", status: 429 });
  let calls = 0;
  await assert.rejects(runExecution("bounded-retry", () => withRateLimitRetry(async () => { consumeCall(); calls += 1; throw original; }), { maxCalls: 1 }), (error) => error === original);
  assert.equal(calls, 1);
});

test("delivery rewriting rejects changed numbers and lost negation", async () => {
  const { preservesLiteralFacts } = await import("./deliveryRewrite.js");
  assert.equal(preservesLiteralFacts("519MB 업로드는 완료되지 않았습니다.", "519MB 업로드 완료."), false);
  assert.equal(preservesLiteralFacts("파일 크기는 519MB입니다.", "파일 크기는 591MB입니다."), false);
  assert.equal(preservesLiteralFacts("파일 크기는 519MB입니다.", "519MB 크기의 파일입니다."), true);
});

test("style checks flag the reported greeting failure and enforce requested sentence counts", async () => {
  const { styleChecks } = await import("../evaluation/prana.js");
  const bad = styleChecks("네, 선생님.\n좋은 밤이네요.\n(다가앉습니다)\n선생님은 잠은 잘 잡니다.\n쉬셔야 합니다.", true);
  assert.equal(bad.teacherLine, false);
  assert.equal(bad.noUnsolicitedScene, false);
  assert.equal(bad.concise, false);
  assert.equal(bad.noKnownGrammarError, false);
  assert.ok(Object.values(styleChecks("선생님.\n좋은 밤입니다.", true)).every(Boolean));
  assert.equal(styleChecks("선생님.\n파일은 519MB이며 재생 시간은 23분 42초입니다.\n업로드는 완료되지 않았습니다.", false, "numbers").requestedSentences, false);
});

test("only plain social turns skip unrelated long-term context", async () => {
  const { answerTurn } = await import("./webSearchAnswer.js");
  const { isSimpleSocialTurn } = await import("./queryPolicy.js");
  assert.equal(isSimpleSocialTurn("프라나야 좋은 밤이야"), true);
  assert.equal(isSimpleSocialTurn("프라나, 있어?"), true);
  assert.equal(isSimpleSocialTurn("고마워. 그런데 환율도 알려줘"), false);
  const mock = installFetch(() => codexStream("선생님.\n좋은 밤입니다."));
  try {
    const settings = testSettings({ deliveryRewriteEnabled: true, ollamaWebSearchEnabled: false });
    await answerTurn({ settings, question: "프라나야 좋은 밤이야", memoryContext: "이전 여행 기록" });
    assert.doesNotMatch(JSON.stringify(mock.requests[0]?.body.input), /이전 여행 기록/u);
    await answerTurn({ settings, question: "반복문을 설명해줘", memoryContext: "이전 여행 기록" });
    assert.match(JSON.stringify(mock.requests[1]?.body.input), /이전 여행 기록/u);
    assert.equal(mock.requests.length, 2);
  } finally { mock.restore(); }
});

test("memory deduplication does not confuse equal text from different roles", () => {
  const messages = buildTurnMessages({ ...parts, history: [{ role: "user", content: "확인했습니다." }], memoryContext: buildMemoryContextMessage("memory_context:\n- assistant: 확인했습니다.") });
  assert.match(messages.find((message) => message.contextKind === "memory")?.content ?? "", /assistant: 확인했습니다/u);
});
