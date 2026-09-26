import type { Settings } from "../config/settings.js";

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    codexApiKey: "cg_test",
    codexBaseUrl: "http://codex.example/v1",
    ollamaApiKeys: ["ollama-key"],
    ollamaSearchHost: "https://ollama.example",
    ollamaWebSearchEnabled: true,
    ollamaWebSearchMaxResults: 3,
    webFetchEnabled: false,
    webFetchTimeoutMs: 1000,
    webFetchMaxBytes: 100000,
    webFetchMaxChars: 12000,
    webFetchMaxTotalChars: 18000,
    chatModel: "gpt-6-astra",
    deliveryRewriteEnabled: false,
    chatThinkingMode: "off",
    systemPrompt: "테스트 시스템",
    personaProfile: "live",
    intimacyEnabled: false,
    continuousChat: true,
    searchQueryRewriteEnabled: true,
    ...overrides,
  };
}
