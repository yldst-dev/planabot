import { resolveDefaultSystemPrompt } from "./persona/index.js";

export type Settings = {
  aiProvider: AiProvider;
  anthropicApiKey: string;
  codexApiKey: string;
  codexBaseUrl: string;
  codexFast: boolean;
  codexImageDetail?: CodexImageDetail;
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

export const CODEX_IMAGE_DETAILS = ["low", "high", "auto"] as const;

export type CodexImageDetail = (typeof CODEX_IMAGE_DETAILS)[number];

export type AiProvider = "codex" | "anthropic";

export const DEFAULT_CODEX_MODEL = "gpt-6-astra";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_ANTHROPIC_AUX_MODEL = "claude-haiku-5-5";

const PROVIDER_ALIASES = new Map<string, AiProvider>([
  ["codex", "codex"],
  ["codex-gateway", "codex"],
  ["codex_gateway", "codex"],
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
]);

export function loadSettings(): Settings {
  const aiProvider = resolveAiProvider();
  const anthropic = aiProvider === "anthropic";
  const anthropicApiKey = readOptionalEnv("ANTHROPIC_API_KEY") ?? "";
  const codexApiKey = readOptionalEnv("CODEX_GATEWAY_API_KEY") ?? "";
  if (anthropic && !anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when PLANABRAIN_AI_PROVIDER=anthropic");
  }
  if (!anthropic && !codexApiKey) {
    throw new Error("CODEX_GATEWAY_API_KEY is required");
  }
  const ollamaApiKeys = resolveOllamaApiKeys();
  const personaProfile = resolvePersonaProfile();
  return {
    aiProvider,
    anthropicApiKey,
    codexApiKey,
    codexBaseUrl: anthropic ? "" : normalizeGatewayBaseUrl(
      readOptionalEnv("PLANABRAIN_CODEX_BASE_URL") ?? readOptionalEnv("CODEX_GATEWAY_BASE_URL"),
      "PLANABRAIN_CODEX_BASE_URL",
    ),
    codexFast: parseBooleanEnv("PLANABRAIN_CODEX_FAST", false),
    codexImageDetail: parseImageDetailEnv("PLANABRAIN_CODEX_IMAGE_DETAIL"),
    ollamaApiKeys,
    ollamaSearchHost: ollamaApiKeys.length > 0 ? resolveOllamaSearchHost() : undefined,
    ollamaWebSearchEnabled: parseBooleanEnv("PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH", false),
    ollamaWebSearchMaxResults: Math.min(10, parseRequiredPositiveIntEnv("PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS", 5)),
    webFetchEnabled: parseBooleanEnv("PLANABRAIN_WEB_FETCH_ENABLED", true),
    webFetchTimeoutMs: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_TIMEOUT_MS", 10000, 1000, 30000),
    webFetchMaxBytes: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_BYTES", 1000000, 1024, 5000000),
    webFetchMaxChars: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_CHARS", 12000, 500, 50000),
    webFetchMaxTotalChars: parseBoundedPositiveIntEnv("PLANABRAIN_WEB_FETCH_MAX_TOTAL_CHARS", 18000, 500, 100000),
    chatModel: anthropic
      ? readOptionalEnv("PLANABRAIN_ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL
      : readOptionalEnv("PLANABRAIN_CODEX_MODEL") ?? DEFAULT_CODEX_MODEL,
    deliveryMaxOutputTokens: parseOptionalPositiveIntEnv("PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS", 1024),
    deliveryRewriteEnabled: parseBooleanEnv("PLANABRAIN_DELIVERY_REWRITE_ENABLED", true),
    chatThinkingMode: parseThinkingModeEnv("PLANABRAIN_CHAT_THINKING_MODE"),
    systemPrompt: process.env.PLANABRAIN_SYSTEM_PROMPT ?? resolveDefaultSystemPrompt(personaProfile),
    personaProfile,
    intimacyEnabled: parseBooleanEnv("PLANABRAIN_INTIMACY_ENABLED", true),
    continuousChat: parseBooleanEnv("PLANABRAIN_CONTINUOUS_CHAT", false),
    searchQueryRewriteEnabled: parseBooleanEnv("PLANABRAIN_SEARCH_QUERY_REWRITE", true),
    intimacyFallbackModel: anthropic ? undefined : readOptionalEnv("PLANABRAIN_INTIMACY_FALLBACK_MODEL"),
    auxModel: anthropic
      ? readOptionalEnv("PLANABRAIN_ANTHROPIC_AUX_MODEL") ?? DEFAULT_ANTHROPIC_AUX_MODEL
      : readOptionalEnv("PLANABRAIN_AUX_MODEL"),
  };
}

function resolveAiProvider(): AiProvider {
  const raw = readOptionalEnv("PLANABRAIN_AI_PROVIDER")?.toLowerCase();
  if (!raw) {
    return "codex";
  }
  const provider = PROVIDER_ALIASES.get(raw);
  if (!provider) {
    throw new Error("PLANABRAIN_AI_PROVIDER must be one of: codex, anthropic");
  }
  return provider;
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

function parseImageDetailEnv(key: string): CodexImageDetail | undefined {
  const normalized = process.env[key]?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((CODEX_IMAGE_DETAILS as readonly string[]).includes(normalized)) {
    return normalized as CodexImageDetail;
  }
  throw new Error(`${key} must be one of: ${CODEX_IMAGE_DETAILS.join(", ")}`);
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
