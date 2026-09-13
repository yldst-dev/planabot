import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultChatModel,
  loadSettings,
  normalizeGeminiWebBaseUrl,
} from "./settings.js";

const MODEL_STUDIO_DEFAULT_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PLANABRAIN_") ||
      key.startsWith("MODEL_STUDIO_") ||
      key.startsWith("GEMINIWEB_")
    ) {
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

test("modelstudio enables web search by default", () => {
  const settings = withEnv(MODEL_STUDIO_ENV, loadSettings);
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

test("openrouter image model is optional and loads the OpenRouter base url", () => {
  const settings = withEnv(
    {
      PLANABRAIN_AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      PLANABRAIN_OPENROUTER_IMAGE_MODEL: "google/gemini-3-flash-preview",
    },
    loadSettings,
  );
  assert.equal(settings.openRouterImageModel, "google/gemini-3-flash-preview");
  assert.equal(settings.openRouterBaseUrl, "https://openrouter.ai/api/v1");
  const plain = withEnv(
    {
      PLANABRAIN_AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
    },
    loadSettings,
  );
  assert.equal(plain.openRouterImageModel, undefined);
});

test("aux provider and model are optional and resolve the provider host", () => {
  const settings = withEnv(
    {
      ...MODEL_STUDIO_ENV,
      OLLAMA_API_KEY: "ollama-key",
      PLANABRAIN_AUX_PROVIDER: "ollama",
      PLANABRAIN_AUX_MODEL: "gemma4:31b",
    },
    loadSettings,
  );
  assert.equal(settings.auxProvider, "ollama");
  assert.equal(settings.auxModel, "gemma4:31b");
  assert.equal(settings.ollamaHost, "https://ollama.com");
  const plain = withEnv(MODEL_STUDIO_ENV, loadSettings);
  assert.equal(plain.auxProvider, undefined);
  assert.equal(plain.auxModel, undefined);
});

const GEMINIWEB_ENV = {
  PLANABRAIN_AI_PROVIDER: "geminiweb",
  PLANABRAIN_GEMINIWEB_API_KEY: "sk-gemini-test",
  PLANABRAIN_GEMINIWEB_BASE_URL: "http://10.0.0.5:8083/v1",
};

test("geminiweb aliases resolve to the same provider", () => {
  for (const alias of ["geminiweb", "gemini-web", "gemini_web", "web2api"]) {
    const settings = withEnv(
      { ...GEMINIWEB_ENV, PLANABRAIN_AI_PROVIDER: alias },
      loadSettings,
    );
    assert.equal(settings.aiProvider, "geminiweb");
  }
});

test("geminiweb requires an api key", () => {
  assert.throws(
    () =>
      withEnv(
        {
          PLANABRAIN_AI_PROVIDER: "geminiweb",
          PLANABRAIN_GEMINIWEB_BASE_URL: "http://10.0.0.5:8083/v1",
        },
        loadSettings,
      ),
    /PLANABRAIN_GEMINIWEB_API_KEY is required when PLANABRAIN_AI_PROVIDER=geminiweb/,
  );
});

test("geminiweb requires a base url", () => {
  assert.throws(
    () =>
      withEnv(
        {
          PLANABRAIN_AI_PROVIDER: "geminiweb",
          PLANABRAIN_GEMINIWEB_API_KEY: "sk-gemini-test",
        },
        loadSettings,
      ),
    /PLANABRAIN_GEMINIWEB_BASE_URL is required when PLANABRAIN_AI_PROVIDER=geminiweb/,
  );
});

test("geminiweb rejects a non http(s) base url", () => {
  assert.throws(
    () =>
      withEnv(
        {
          ...GEMINIWEB_ENV,
          PLANABRAIN_GEMINIWEB_BASE_URL: "ftp://10.0.0.5:8083",
        },
        loadSettings,
      ),
    /PLANABRAIN_GEMINIWEB_BASE_URL must be a valid http\(s\) URL/,
  );
});

test("geminiweb appends /v1 when the base url has no path", () => {
  const settings = withEnv(
    {
      ...GEMINIWEB_ENV,
      PLANABRAIN_GEMINIWEB_BASE_URL: "http://10.0.0.5:8083",
    },
    loadSettings,
  );
  assert.equal(settings.geminiWebBaseUrl, "http://10.0.0.5:8083/v1");
});

test("geminiweb strips a trailing slash from an existing /v1 path", () => {
  const settings = withEnv(
    {
      ...GEMINIWEB_ENV,
      PLANABRAIN_GEMINIWEB_BASE_URL: "http://10.0.0.5:8083/v1/",
    },
    loadSettings,
  );
  assert.equal(settings.geminiWebBaseUrl, "http://10.0.0.5:8083/v1");
});

test("geminiweb keeps a base url that already ends with /v1", () => {
  const settings = withEnv(GEMINIWEB_ENV, loadSettings);
  assert.equal(settings.geminiWebBaseUrl, "http://10.0.0.5:8083/v1");
});

test("geminiweb never injects /api/v1 into the base url", () => {
  assert.equal(
    normalizeGeminiWebBaseUrl(
      "http://10.0.0.5:8083",
      "PLANABRAIN_GEMINIWEB_BASE_URL",
    ),
    "http://10.0.0.5:8083/v1",
  );
  assert.equal(
    normalizeGeminiWebBaseUrl(
      "http://10.0.0.5:8083/v1",
      "PLANABRAIN_GEMINIWEB_BASE_URL",
    ),
    "http://10.0.0.5:8083/v1",
  );
  assert.doesNotMatch(
    normalizeGeminiWebBaseUrl(
      "http://10.0.0.5:8083",
      "PLANABRAIN_GEMINIWEB_BASE_URL",
    ),
    /\/api\/v1/,
  );
});

test("geminiweb defaults to gemini-3.8-flash and honours the model override", () => {
  assert.equal(defaultChatModel("geminiweb"), "gemini-3.8-flash");
  assert.equal(withEnv(GEMINIWEB_ENV, loadSettings).chatModel, "gemini-3.8-flash");
  assert.equal(
    withEnv(
      { ...GEMINIWEB_ENV, PLANABRAIN_CHAT_MODEL: "gemini-3.6-flash" },
      loadSettings,
    ).chatModel,
    "gemini-3.6-flash",
  );
  assert.equal(
    withEnv(
      {
        ...GEMINIWEB_ENV,
        PLANABRAIN_CHAT_MODEL: "gemini-3.6-flash",
        PLANABRAIN_GEMINIWEB_MODEL: "gemini-3.1-pro",
      },
      loadSettings,
    ).chatModel,
    "gemini-3.1-pro",
  );
});

test("geminiweb accepts GEMINIWEB_API_KEY as an alias", () => {
  const settings = withEnv(
    {
      PLANABRAIN_AI_PROVIDER: "geminiweb",
      GEMINIWEB_API_KEY: "sk-gemini-alias",
      PLANABRAIN_GEMINIWEB_BASE_URL: "http://10.0.0.5:8083/v1",
    },
    loadSettings,
  );
  assert.equal(settings.geminiWebApiKey, "sk-gemini-alias");
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
