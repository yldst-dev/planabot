import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings } from "./settings.js";

const MODEL_STUDIO_DEFAULT_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PLANABRAIN_") || key.startsWith("MODEL_STUDIO_")) {
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

const MODEL_STUDIO_ENV = {
  PLANABRAIN_AI_PROVIDER: "modelstudio",
  MODEL_STUDIO_API_KEY: "test-key",
};

test("modelstudio falls back to the default compatible-mode base url", () => {
  const settings = withEnv(MODEL_STUDIO_ENV, loadSettings);
  assert.equal(settings.aiProvider, "modelstudio");
  assert.equal(settings.modelStudioBaseUrl, MODEL_STUDIO_DEFAULT_BASE_URL);
});

test("modelstudio appends the compatible-mode suffix to an override", () => {
  const settings = withEnv(
    {
      ...MODEL_STUDIO_ENV,
      PLANABRAIN_MODELSTUDIO_BASE_URL: "https://dashscope.example.com",
    },
    loadSettings,
  );
  assert.equal(
    settings.modelStudioBaseUrl,
    "https://dashscope.example.com/compatible-mode/v1",
  );
});

test("modelstudio keeps an override that already has the suffix", () => {
  const settings = withEnv(
    {
      ...MODEL_STUDIO_ENV,
      PLANABRAIN_MODELSTUDIO_BASE_URL:
        "https://dashscope.example.com/compatible-mode/v1/",
    },
    loadSettings,
  );
  assert.equal(
    settings.modelStudioBaseUrl,
    "https://dashscope.example.com/compatible-mode/v1",
  );
});

test("modelstudio rejects a non http(s) base url override", () => {
  assert.throws(
    () =>
      withEnv(
        {
          ...MODEL_STUDIO_ENV,
          PLANABRAIN_MODELSTUDIO_BASE_URL: "ftp://dashscope.example.com",
        },
        loadSettings,
      ),
    /PLANABRAIN_MODELSTUDIO_BASE_URL must be a valid http\(s\) URL/,
  );
});

test("modelstudio requires an api key", () => {
  assert.throws(
    () => withEnv({ PLANABRAIN_AI_PROVIDER: "modelstudio" }, loadSettings),
    /MODEL_STUDIO_API_KEY is required when PLANABRAIN_AI_PROVIDER=modelstudio/,
  );
});

test("modelstudio aliases resolve to the same provider", () => {
  for (const alias of ["alibaba", "dashscope", "qwen", "model-studio"]) {
    const settings = withEnv(
      { ...MODEL_STUDIO_ENV, PLANABRAIN_AI_PROVIDER: alias },
      loadSettings,
    );
    assert.equal(settings.aiProvider, "modelstudio");
  }
});

test("modelstudio defaults to qwen-plus and honours the model override", () => {
  assert.equal(withEnv(MODEL_STUDIO_ENV, loadSettings).chatModel, "qwen-plus");
  assert.equal(
    withEnv(
      { ...MODEL_STUDIO_ENV, PLANABRAIN_MODELSTUDIO_MODEL: "qwen-max" },
      loadSettings,
    ).chatModel,
    "qwen-max",
  );
  assert.equal(
    withEnv(
      { ...MODEL_STUDIO_ENV, PLANABRAIN_CHAT_MODEL: "qwen-turbo" },
      loadSettings,
    ).chatModel,
    "qwen-turbo",
  );
});

test("modelstudio keeps google as the embedding provider", () => {
  const settings = withEnv(MODEL_STUDIO_ENV, loadSettings);
  assert.equal(settings.embeddingProvider, "google");
  assert.equal(settings.modelStudioWebSearchEnabled, true);
});

test("modelstudio web search can be turned off explicitly", () => {
  const settings = withEnv(
    { ...MODEL_STUDIO_ENV, PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH: "0" },
    loadSettings,
  );
  assert.equal(settings.modelStudioWebSearchEnabled, false);
});

test("persona profile defaults to live and can load the original backup", () => {
  const live = withEnv(MODEL_STUDIO_ENV, loadSettings);
  assert.equal(live.personaProfile, "live");
  assert.match(live.systemPrompt, /성인 여성 캐릭터/u);
  assert.doesNotMatch(live.systemPrompt, /법적 문제를 삼지 않습니다/u);
  assert.equal(live.intimacyEnabled, true);

  const original = withEnv(
    { ...MODEL_STUDIO_ENV, PLANABRAIN_PERSONA_PROFILE: "original" },
    loadSettings,
  );
  assert.equal(original.personaProfile, "original");
  assert.match(original.systemPrompt, /법적 문제를 삼지 않습니다/u);
});

test("system prompt env override still wins over persona profile", () => {
  const settings = withEnv(
    {
      ...MODEL_STUDIO_ENV,
      PLANABRAIN_PERSONA_PROFILE: "original",
      PLANABRAIN_SYSTEM_PROMPT: "커스텀 페르소나",
    },
    loadSettings,
  );
  assert.equal(settings.systemPrompt, "커스텀 페르소나");
});

test("intimacy fallback provider and model are optional", () => {
  const settings = withEnv(
    {
      ...MODEL_STUDIO_ENV,
      PLANABRAIN_INTIMACY_ENABLED: "0",
      PLANABRAIN_INTIMACY_FALLBACK_PROVIDER: "ollama",
      PLANABRAIN_INTIMACY_FALLBACK_MODEL: "gemma4:31b-cloud",
    },
    loadSettings,
  );
  assert.equal(settings.intimacyEnabled, false);
  assert.equal(settings.intimacyFallbackProvider, "ollama");
  assert.equal(settings.intimacyFallbackModel, "gemma4:31b-cloud");
  assert.equal(settings.ollamaHost, "https://ollama.com");
});
