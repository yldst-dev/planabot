import { resolveDefaultSystemPrompt } from "./persona/index.js";

export type Settings = {
  codexApiKey: string;
  codexBaseUrl: string;
  ollamaApiKeys: string[];
  ollamaSearchHost?: string;
  ollamaWebSearchEnabled: boolean;
  ollamaWebSearchMaxResults: number;
  webFetchEnabled: boolean;
  webFetchTimeoutMs: number;
  webFetchMaxBytes: number;
  webFetchMaxChars: number;
  webFetchMaxTotalChars: number;
  chatModel: string;
  deliveryMaxOutputTokens?: number;
  deliveryRewriteEnabled: boolean;
  chatThinkingMode: "default" | "off" | "minimal" | "low" | "medium" | "high";
  systemPrompt: string;
  personaProfile: "live" | "original";
  intimacyEnabled: boolean;
  continuousChat: boolean;
  searchQueryRewriteEnabled: boolean;
  intimacyFallbackModel?: string;
  auxModel?: string;
};

export const DEFAULT_CODEX_MODEL = "gpt-6-astra";

const CODEX_PROVIDER_NAMES = new Set(["codex", "codex-gateway", "codex_gateway"]);
const PROVIDER_KEYS = ["PLANABRAIN_AI_PROVIDER", "PLANABRAIN_AUX_PROVIDER", "PLANABRAIN_INTIMACY_FALLBACK_PROVIDER"];

export function loadSettings(): Settings {
  for (const key of PROVIDER_KEYS) {
    const value = readOptionalEnv(key)?.toLowerCase();
    if (value && !CODEX_PROVIDER_NAMES.has(value)) {
      throw new Error(`${key} must be codex (codex-gateway, codex_gateway)`);
    }
  }
  const codexApiKey = readOptionalEnv("CODEX_GATEWAY_API_KEY");
  if (!codexApiKey) {
    throw new Error("CODEX_GATEWAY_API_KEY is required");
  }
  const ollamaApiKeys = resolveOllamaApiKeys();
  const personaProfile = resolvePersonaProfile();
  return {
    codexApiKey,
    codexBaseUrl: normalizeGatewayBaseUrl(
      readOptionalEnv("PLANABRAIN_CODEX_BASE_URL") ?? readOptionalEnv("CODEX_GATEWAY_BASE_URL"),
      "PLANABRAIN_CODEX_BASE_URL",
    ),
    ollamaApiKeys,
    ollamaSearchHost: ollamaApiKeys.length > 0 ? resolveOllamaSearchHost() : undefined,
    ollamaWebSearchEnabled: parseBooleanEnv("PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH", false),
    ollamaWebSearchMaxResults: parseRequiredPositiveIntEnv("PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS", 5),
    webFetchEnabled: parseBooleanEnv("PLANABRAIN_WEB_FETCH_ENABLED", true),
    webFetchTimeoutMs: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_TIMEOUT_MS", 10000, 1000, 30000),
    webFetchMaxBytes: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_BYTES", 1000000, 1024, 5000000),
    webFetchMaxChars: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_CHARS", 12000, 500, 50000),
    webFetchMaxTotalChars: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_TOTAL_CHARS", 18000, 500, 100000),
    chatModel: readOptionalEnv("PLANABRAIN_CODEX_MODEL") ?? DEFAULT_CODEX_MODEL,
    deliveryMaxOutputTokens: parseOptionalPositiveIntEnv("PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS", 1024),
    deliveryRewriteEnabled: parseBooleanEnv("PLANABRAIN_DELIVERY_REWRITE_ENABLED", true),
    chatThinkingMode: parseThinkingModeEnv("PLANABRAIN_CHAT_THINKING_MODE"),
    systemPrompt: process.env.PLANABRAIN_SYSTEM_PROMPT ?? resolveDefaultSystemPrompt(personaProfile),
    personaProfile,
    intimacyEnabled: parseBooleanEnv("PLANABRAIN_INTIMACY_ENABLED", true),
    continuousChat: parseBooleanEnv("PLANABRAIN_CONTINUOUS_CHAT", false),
    searchQueryRewriteEnabled: parseBooleanEnv("PLANABRAIN_SEARCH_QUERY_REWRITE", true),
    intimacyFallbackModel: readOptionalEnv("PLANABRAIN_INTIMACY_FALLBACK_MODEL"),
    auxModel: readOptionalEnv("PLANABRAIN_AUX_MODEL"),
  };
}

function resolvePersonaProfile(): "live" | "original" {
  const raw = process.env.PLANABRAIN_PERSONA_PROFILE;
  if (raw == null) {
    return "live";
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "live" || normalized === "default") {
    return "live";
  }
  if (normalized === "original" || normalized === "backup") {
    return "original";
  }
  throw new Error("PLANABRAIN_PERSONA_PROFILE must be one of: live, original");
}

export function normalizeGatewayBaseUrl(raw: string | undefined, name: string): string {
  if (!raw?.trim()) {
    throw new Error(`${name} is required`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an http(s) URL without credentials, query or fragment`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname || "/v1"}`;
}

function resolveOllamaSearchHost(): string {
  const explicit = readOptionalEnv("PLANABRAIN_OLLAMA_SEARCH_HOST");
  if (!explicit) {
    return "https://ollama.com";
  }
  const url = URL.canParse(explicit) ? new URL(explicit) : undefined;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("PLANABRAIN_OLLAMA_SEARCH_HOST must be a valid http(s) URL");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function resolveOllamaApiKeys(): string[] {
  return [...new Set([...splitEnvList(process.env.OLLAMA_API_KEYS), ...splitEnvList(process.env.OLLAMA_API_KEY)])];
}

function parseOptionalPositiveIntEnv(key: string, defaultValue: number): number | undefined {
  const raw = process.env[key];
  if (raw == null) {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "0" || trimmed.toLowerCase() === "false") {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer (or 0 to disable)`);
  }
  return value;
}

function parseRequiredPositiveIntEnv(key: string, defaultValue: number): number {
  const trimmed = process.env[key]?.trim();
  if (!trimmed) {
    return defaultValue;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function parseBoundedPositiveIntEnv(key: string, defaultValue: number, minValue: number, maxValue: number): number {
  const value = parseRequiredPositiveIntEnv(key, defaultValue);
  if (value < minValue || value > maxValue) {
    throw new Error(`${key} must be between ${minValue} and ${maxValue}`);
  }
  return value;
}

function parseThinkingModeEnv(key: string): Settings["chatThinkingMode"] {
  const normalized = process.env[key]?.trim().toLowerCase();
  if (!normalized || normalized === "default" || normalized === "auto" || normalized === "on") {
    return "default";
  }
  if (normalized === "off" || normalized === "none") {
    return "off";
  }
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  throw new Error(`${key} must be one of: default, off, minimal, low, medium, high`);
}

function splitEnvList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBooleanEnv(key: string, defaultValue: boolean): boolean {
  const normalized = process.env[key]?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${key} must be a boolean value`);
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}
