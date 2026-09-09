import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import {
  invokeChatWithMetadata,
  isSearchToolAvailable,
  providerHasCredentials,
} from "./chat.js";

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

test("unsupported provider names fail clearly", async () => {
  await assert.rejects(
    invokeChatWithMetadata({
      settings: settingsFor({ aiProvider: "nope" as Settings["aiProvider"] }),
      messages: [{ role: "user", content: "안녕" }],
    }),
    /지원하지 않는 provider/u,
  );
});
