import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import { resolveAuxSettings } from "./auxSettings.js";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    aiProvider: "openrouter",
    openRouterApiKey: "gateway-key",
    openRouterBaseUrl: "http://gateway.example/v1",
    chatModel: "gemini-3.7-flash",
    chatThinkingMode: "default",
    ollamaApiKeys: [],
    ...overrides,
  } as Settings;
}

test("aux settings keep the main provider and model when nothing is configured", () => {
  const aux = resolveAuxSettings(createSettings());
  assert.equal(aux.aiProvider, "openrouter");
  assert.equal(aux.chatModel, "gemini-3.7-flash");
  assert.equal(aux.chatThinkingMode, "off");
});

test("aux model alone swaps the model on the main provider", () => {
  const aux = resolveAuxSettings(createSettings({ auxModel: "gemini-3.5-flash-lite" }));
  assert.equal(aux.aiProvider, "openrouter");
  assert.equal(aux.chatModel, "gemini-3.5-flash-lite");
});

test("aux provider with credentials is used with its own or default model", () => {
  const withModel = resolveAuxSettings(
    createSettings({ auxProvider: "ollama", auxModel: "gemma4:31b", ollamaApiKeys: ["k"] }),
  );
  assert.equal(withModel.aiProvider, "ollama");
  assert.equal(withModel.chatModel, "gemma4:31b");
  const withDefault = resolveAuxSettings(
    createSettings({ auxProvider: "ollama", ollamaApiKeys: ["k"] }),
  );
  assert.equal(withDefault.aiProvider, "ollama");
  assert.equal(withDefault.chatModel, "gemma4:31b-cloud");
});

test("aux provider without credentials falls back to the main provider", () => {
  const aux = resolveAuxSettings(
    createSettings({ auxProvider: "ollama", auxModel: "gemma4:31b" }),
  );
  assert.equal(aux.aiProvider, "openrouter");
  assert.equal(aux.chatModel, "gemini-3.7-flash");
});
