import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import {
  invokeChatWithMetadata,
  isSearchToolAvailable,
  providerHasCredentials,
} from "./chat.js";
import { GLM_53_FLASH_VISION_UNAVAILABLE } from "./providers/registry.js";

function settingsFor(overrides: Partial<Settings>): Settings {
  return { ollamaApiKeys: [], ...overrides } as Settings;
}

test("unknown providers have no search tool and no credentials", () => {
  const settings = settingsFor({ aiProvider: "nope" as Settings["aiProvider"] });
  assert.equal(isSearchToolAvailable(settings), false);
  assert.equal(providerHasCredentials(settings, "nope" as Settings["aiProvider"]), false);
});

test("credentials are resolved per provider from the registry", () => {
  const settings = settingsFor({
    googleApiKey: "g",
    cerebrasApiKey: "c",
    ollamaApiKeys: ["o"],
  });
  assert.equal(providerHasCredentials(settings, "google"), true);
  assert.equal(providerHasCredentials(settings, "cerebras"), true);
  assert.equal(providerHasCredentials(settings, "ollama"), true);
  assert.equal(providerHasCredentials(settings, "openrouter"), false);
  assert.equal(providerHasCredentials(settings, "modelstudio"), false);
  assert.equal(providerHasCredentials(settings, "geminiweb"), false);
});

test("geminiweb credentials require both key and base url", () => {
  assert.equal(
    providerHasCredentials(settingsFor({ geminiWebApiKey: "k" }), "geminiweb"),
    false,
  );
  assert.equal(
    providerHasCredentials(
      settingsFor({ geminiWebBaseUrl: "http://10.0.0.5:8083/v1" }),
      "geminiweb",
    ),
    false,
  );
  assert.equal(
    providerHasCredentials(
      settingsFor({
        geminiWebApiKey: "k",
        geminiWebBaseUrl: "http://10.0.0.5:8083/v1",
      }),
      "geminiweb",
    ),
    true,
  );
});

test("providers without image support reject image messages before any request", async () => {
  for (const aiProvider of ["modelstudio", "geminimock"] as const) {
    await assert.rejects(
      invokeChatWithMetadata({
        settings: settingsFor({ aiProvider, googleApiKey: "g", modelStudioApiKey: "m" }),
        messages: [
          {
            role: "user",
            content: "이 사진 봐줘",
            images: [{ mimeType: "image/png", data: "AAAA" }],
          },
        ],
      }),
      /현재 선택한 모델 연결은 이미지 입력을 지원하지 않습니다/u,
    );
  }
});

test("geminiweb accepts image messages", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "확인 완료." },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const result = await invokeChatWithMetadata({
      settings: settingsFor({
        aiProvider: "geminiweb",
        geminiWebApiKey: "k",
        geminiWebBaseUrl: "http://10.0.0.5:8083/v1",
        chatModel: "gemini-3.8-flash",
      }),
      messages: [
        {
          role: "user",
          content: "이 사진 봐줘",
          images: [{ mimeType: "image/png", data: "AAAA" }],
        },
      ],
    });
    assert.equal(result.content, "확인 완료.");
  } finally {
    globalThis.fetch = original;
  }
});

test("openrouter image requests require parameters and send image_url", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "빨강" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await invokeChatWithMetadata({
      settings: settingsFor({
        aiProvider: "openrouter",
        openRouterApiKey: "sk-or-test",
        openRouterBaseUrl: "https://openrouter.ai/api/v1",
        chatModel: "google/gemini-3-flash-preview",
      }),
      messages: [
        {
          role: "user",
          content: "이 사진 봐줘",
          images: [{ mimeType: "image/jpeg", data: "AAAA" }],
        },
      ],
    });
    assert.equal(result.content, "빨강");
    assert.ok(body);
    const provider = body.provider as Record<string, unknown>;
    assert.equal(provider.require_parameters, true);
    assert.equal(provider.allow_fallbacks, true);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]?.content, [
      { type: "text", text: "이 사진 봐줘" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("glm-5.3-flash image requests skip the provider and return the vision notice", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("provider must not be called");
  }) as typeof fetch;
  try {
    const result = await invokeChatWithMetadata({
      settings: settingsFor({
        aiProvider: "openrouter",
        openRouterApiKey: "sk-or-test",
        openRouterBaseUrl: "https://openrouter.ai/api/v1",
        chatModel: "z-ai/glm-5.3-flash",
      }),
      messages: [
        {
          role: "user",
          content: "이 사진 봐줘",
          images: [{ mimeType: "image/jpeg", data: "AAAA" }],
        },
      ],
    });
    assert.equal(result.content, GLM_53_FLASH_VISION_UNAVAILABLE);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("unsupported provider names fail clearly", async () => {
  await assert.rejects(
    invokeChatWithMetadata({
      settings: settingsFor({ aiProvider: "nope" as Settings["aiProvider"] }),
      messages: [{ role: "user", content: "안녕" }],
    }),
    /지원하지 않는 provider/u,
  );
});
