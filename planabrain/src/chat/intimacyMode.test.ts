import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import { INTIMACY_UNAVAILABLE_REPLY } from "../config/persona/index.js";
import {
  isPolicyRefusal,
  isSafetyFinishReason,
  isSafetyInvocationError,
  looksUserInitiatedIntimacy,
  providerHasCredentials,
  replaceSystemContent,
  resolveIntimacyRetrySettings,
} from "./intimacyMode.js";

test("detects explicit adult turns and ignores ordinary chat", () => {
  assert.equal(looksUserInitiatedIntimacy("오늘 날씨 알려줘"), false);
  assert.equal(looksUserInitiatedIntimacy("야구 점수 알려줘"), false);
  assert.equal(looksUserInitiatedIntimacy("야한 채팅 하자"), true);
  assert.equal(looksUserInitiatedIntimacy("옷을 벗어"), true);
  assert.equal(looksUserInitiatedIntimacy("안아줘"), true);
  assert.equal(looksUserInitiatedIntimacy("손 잡아"), true);
  assert.equal(looksUserInitiatedIntimacy("키스해"), true);
});

test("treats short continuation as adult only after an adult history turn", () => {
  assert.equal(looksUserInitiatedIntimacy("계속"), false);
  assert.equal(looksUserInitiatedIntimacy("계속", ["야한 채팅 이어서"]), true);
  assert.equal(looksUserInitiatedIntimacy("더 해줘", ["어제 환율 알려줬어"]), false);
});

test("classifies safety finish reasons and policy refusals", () => {
  assert.equal(isSafetyFinishReason("SAFETY"), true);
  assert.equal(isSafetyFinishReason("PROHIBITED_CONTENT"), true);
  assert.equal(isSafetyFinishReason("MAX_TOKENS"), false);
  assert.equal(isPolicyRefusal("", "SAFETY"), true);
  assert.equal(
    isPolicyRefusal("I can't help with that request."),
    true,
  );
  assert.equal(
    isPolicyRefusal("죄송하지만 도와드릴 수 없습니다."),
    true,
  );
  assert.equal(
    isPolicyRefusal("불가.\n선생님.\n해당 정보는 제공할 수 없습니다."),
    false,
  );
  assert.equal(
    isPolicyRefusal("불가.\n선생님.\n해당 정보는 제공할 수 없습니다.", undefined, {
      intimacyActive: true,
    }),
    true,
  );
  assert.equal(isPolicyRefusal("확인 완료.\n선생님."), false);
  assert.equal(
    isPolicyRefusal(
      "선생님.\n해당 동작은 수행할 수 없습니다.\n물리적 접촉은 불가능합니다.",
    ),
    true,
  );
});

test("detects blocked-prompt errors from providers", () => {
  assert.equal(
    isSafetyInvocationError(new Error("Vertex Express API blocked prompt: SAFETY")),
    true,
  );
  assert.equal(isSafetyInvocationError(new Error("rate limited")), false);
});

test("retry settings switch provider only when credentials exist", () => {
  const settings = {
    aiProvider: "google",
    chatModel: "gemini-3-flash-preview",
    chatThinkingMode: "high",
    googleApiKey: "google-key",
    ollamaApiKeys: [],
    intimacyFallbackProvider: "ollama",
    intimacyFallbackModel: "gemma4:31b-cloud",
  } as unknown as Settings;
  const sameProvider = resolveIntimacyRetrySettings(settings);
  assert.equal(sameProvider.aiProvider, "google");
  assert.equal(sameProvider.chatModel, "gemini-3-flash-preview");
  assert.equal(sameProvider.chatThinkingMode, "off");

  const withOllama = resolveIntimacyRetrySettings({
    ...settings,
    ollamaApiKeys: ["ollama-key"],
  });
  assert.equal(withOllama.aiProvider, "ollama");
  assert.equal(withOllama.chatModel, "gemma4:31b-cloud");
  assert.equal(providerHasCredentials(withOllama, "ollama"), true);
});

test("replaceSystemContent updates the first system message", () => {
  const replaced = replaceSystemContent(
    [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
    ],
    "new",
  );
  assert.deepEqual(replaced, [
    { role: "system", content: "new" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(INTIMACY_UNAVAILABLE_REPLY.includes("선생님."), true);
});
