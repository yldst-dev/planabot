import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CODEX_MODEL, loadSettings, normalizeGatewayBaseUrl } from "./settings.js";

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PLANABRAIN_") || key.startsWith("CODEX_") || key.startsWith("OLLAMA_")) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

const CODEX_ENV = {
  CODEX_GATEWAY_API_KEY: "cg_test",
  PLANABRAIN_CODEX_BASE_URL: "http://192.168.0.9:8080",
};

test("codex defaults to gpt-6-astra and ignores stale chat model settings", () => {
  const settings = withEnv({ ...CODEX_ENV, PLANABRAIN_CHAT_MODEL: "gemini-3.7-flash" }, loadSettings);
  assert.equal(settings.chatModel, DEFAULT_CODEX_MODEL);
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-6-astra");
  assert.equal(settings.codexApiKey, "cg_test");
  assert.equal(settings.codexBaseUrl, "http://192.168.0.9:8080/v1");
  assert.equal(withEnv({ ...CODEX_ENV, PLANABRAIN_CODEX_MODEL: " gpt-6-luna " }, loadSettings).chatModel, "gpt-6-luna");
});

test("codex requires a key and a gateway URL, accepting the handoff variable name", () => {
  assert.throws(() => withEnv({ ...CODEX_ENV, CODEX_GATEWAY_API_KEY: " " }, loadSettings), /CODEX_GATEWAY_API_KEY/);
  assert.throws(() => withEnv({ ...CODEX_ENV, PLANABRAIN_CODEX_BASE_URL: " " }, loadSettings), /PLANABRAIN_CODEX_BASE_URL/);
  const settings = withEnv({ ...CODEX_ENV, PLANABRAIN_CODEX_BASE_URL: "", CODEX_GATEWAY_BASE_URL: "http://gateway:8080/v1/" }, loadSettings);
  assert.equal(settings.codexBaseUrl, "http://gateway:8080/v1");
});

test("provider variables accept only codex aliases", () => {
  for (const key of ["PLANABRAIN_AI_PROVIDER", "PLANABRAIN_AUX_PROVIDER", "PLANABRAIN_INTIMACY_FALLBACK_PROVIDER"]) {
    for (const alias of ["codex", "Codex-Gateway", "codex_gateway"]) {
      assert.doesNotThrow(() => withEnv({ ...CODEX_ENV, [key]: alias }, loadSettings));
    }
    assert.throws(() => withEnv({ ...CODEX_ENV, [key]: "openrouter" }, loadSettings), new RegExp(key));
  }
});

test("fast mode is off unless enabled", () => {
  assert.equal(withEnv(CODEX_ENV, loadSettings).codexFast, false);
  assert.equal(withEnv({ ...CODEX_ENV, PLANABRAIN_CODEX_FAST: "1" }, loadSettings).codexFast, true);
  assert.throws(() => withEnv({ ...CODEX_ENV, PLANABRAIN_CODEX_FAST: "maybe" }, loadSettings), /PLANABRAIN_CODEX_FAST/);
});

test("gateway URLs are normalized and reject credentials or invalid schemes", () => {
  for (const [input, expected] of [
    ["http://gateway:8080", "http://gateway:8080/v1"],
    ["http://gateway:8080/v1/", "http://gateway:8080/v1"],
    ["https://gateway.example/custom", "https://gateway.example/custom"],
  ]) {
    assert.equal(normalizeGatewayBaseUrl(input, "GATEWAY_URL"), expected);
  }
  for (const input of ["ftp://gateway", "http://user:pass@gateway", "http://gateway/v1?x=1", "not a url"]) {
    assert.throws(() => normalizeGatewayBaseUrl(input, "GATEWAY_URL"), /GATEWAY_URL/);
  }
});

test("aux and intimacy fallback models are optional", () => {
  const settings = withEnv({ ...CODEX_ENV, PLANABRAIN_AUX_MODEL: "gpt-5.6-sol", PLANABRAIN_INTIMACY_FALLBACK_MODEL: "gpt-5.5", PLANABRAIN_INTIMACY_ENABLED: "0" }, loadSettings);
  assert.equal(settings.auxModel, "gpt-5.6-sol");
  assert.equal(settings.intimacyFallbackModel, "gpt-5.5");
  assert.equal(settings.intimacyEnabled, false);
  assert.equal(withEnv(CODEX_ENV, loadSettings).auxModel, undefined);
});

test("ollama pre-search needs the flag, a key and a valid host", () => {
  const off = withEnv(CODEX_ENV, loadSettings);
  assert.equal(off.ollamaWebSearchEnabled, false);
  assert.equal(off.ollamaSearchHost, undefined);
  const on = withEnv({ ...CODEX_ENV, PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH: "1", OLLAMA_API_KEYS: "a, b", OLLAMA_API_KEY: "b" }, loadSettings);
  assert.equal(on.ollamaWebSearchEnabled, true);
  assert.deepEqual(on.ollamaApiKeys, ["a", "b"]);
  assert.equal(on.ollamaSearchHost, "https://ollama.com");
  assert.throws(() => withEnv({ ...CODEX_ENV, OLLAMA_API_KEY: "k", PLANABRAIN_OLLAMA_SEARCH_HOST: "ftp://x" }, loadSettings), /PLANABRAIN_OLLAMA_SEARCH_HOST/);
});

test("thinking mode accepts known levels and rejects others", () => {
  assert.equal(withEnv(CODEX_ENV, loadSettings).chatThinkingMode, "default");
  assert.equal(withEnv({ ...CODEX_ENV, PLANABRAIN_CHAT_THINKING_MODE: "none" }, loadSettings).chatThinkingMode, "off");
  assert.equal(withEnv({ ...CODEX_ENV, PLANABRAIN_CHAT_THINKING_MODE: "minimal" }, loadSettings).chatThinkingMode, "minimal");
  assert.throws(() => withEnv({ ...CODEX_ENV, PLANABRAIN_CHAT_THINKING_MODE: "ultra" }, loadSettings), /PLANABRAIN_CHAT_THINKING_MODE/);
});

test("persona profile defaults to live and can load the original backup", () => {
  const live = withEnv(CODEX_ENV, loadSettings);
  assert.equal(live.personaProfile, "live");
  assert.match(live.systemPrompt, /차분하고 간결한 한국어 존댓말/u);
  assert.doesNotMatch(live.systemPrompt, /법적 문제를 삼지 않습니다/u);
  assert.equal(live.intimacyEnabled, true);

  const original = withEnv({ ...CODEX_ENV, PLANABRAIN_PERSONA_PROFILE: "original" }, loadSettings);
  assert.equal(original.personaProfile, "original");
  assert.match(original.systemPrompt, /법적 문제를 삼지 않습니다/u);
});

test("system prompt env override still wins over persona profile", () => {
  const settings = withEnv({ ...CODEX_ENV, PLANABRAIN_PERSONA_PROFILE: "original", PLANABRAIN_SYSTEM_PROMPT: "커스텀 페르소나" }, loadSettings);
  assert.equal(settings.systemPrompt, "커스텀 페르소나");
});
