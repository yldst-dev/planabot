import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings, type Settings } from "../config/settings.js";
import { isSearchToolAvailable } from "./gemini/chat.js";

function settingsFor(overrides: Partial<Settings>): Settings {
  return {
    aiProvider: "openrouter",
    openRouterWebSearchEnabled: true,
    cerebrasWebSearchEnabled: true,
    modelStudioWebSearchEnabled: true,
    ollamaWebSearchEnabled: true,
    ollamaApiKeys: ["key"],
    ...overrides,
  } as Settings;
}

test("openrouter exposes the search tool unless it is disabled", () => {
  assert.equal(isSearchToolAvailable(settingsFor({})), true);
  assert.equal(
    isSearchToolAvailable(settingsFor({ openRouterWebSearchEnabled: false })),
    false,
  );
});

test("cerebras needs both the flag and an ollama key", () => {
  const base = { aiProvider: "cerebras" } as Partial<Settings>;
  assert.equal(isSearchToolAvailable(settingsFor(base)), true);
  assert.equal(
    isSearchToolAvailable(settingsFor({ ...base, ollamaApiKeys: [] })),
    false,
  );
  assert.equal(
    isSearchToolAvailable(
      settingsFor({ ...base, cerebrasWebSearchEnabled: false }),
    ),
    false,
  );
});

test("modelstudio web search defaults to enabled", () => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PLANABRAIN_") || key.startsWith("MODEL_STUDIO_")) {
      delete process.env[key];
    }
  }
  process.env.PLANABRAIN_AI_PROVIDER = "modelstudio";
  process.env.MODEL_STUDIO_API_KEY = "test-key";
  try {
    assert.equal(loadSettings().modelStudioWebSearchEnabled, true);
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test("modelstudio needs both the flag and an ollama key", () => {
  const base = { aiProvider: "modelstudio" } as Partial<Settings>;
  assert.equal(isSearchToolAvailable(settingsFor(base)), true);
  assert.equal(
    isSearchToolAvailable(settingsFor({ ...base, ollamaApiKeys: [] })),
    false,
  );
  assert.equal(
    isSearchToolAvailable(
      settingsFor({ ...base, modelStudioWebSearchEnabled: false }),
    ),
    false,
  );
});

test("ollama follows its own web search flag", () => {
  const base = { aiProvider: "ollama" } as Partial<Settings>;
  assert.equal(isSearchToolAvailable(settingsFor(base)), true);
  assert.equal(
    isSearchToolAvailable(
      settingsFor({ ...base, ollamaWebSearchEnabled: false }),
    ),
    false,
  );
});

test("google providers always expose the search tool", () => {
  assert.equal(
    isSearchToolAvailable(settingsFor({ aiProvider: "google" })),
    true,
  );
  assert.equal(
    isSearchToolAvailable(settingsFor({ aiProvider: "vertexexpress" })),
    true,
  );
});

test("geminimock never exposes the search tool", () => {
  assert.equal(
    isSearchToolAvailable(settingsFor({ aiProvider: "geminimock" })),
    false,
  );
});
