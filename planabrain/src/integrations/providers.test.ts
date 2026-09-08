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
});

test("providers without image support reject image messages before any request", async () => {
  for (const aiProvider of ["google", "modelstudio", "geminimock"] as const) {
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
      /이미지 입력은 현재 openrouter 또는 ollama provider에서만 지원합니다/u,
    );
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
