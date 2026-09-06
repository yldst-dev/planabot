import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveDefaultSystemPrompt } from "./persona/index.js";

export type Settings = {
  aiProvider:
    | "google"
    | "vertexexpress"
    | "geminimock"
    | "openrouter"
    | "ollama"
    | "cerebras"
    | "modelstudio";
  googleApiKey?: string;
  vertexExpressApiKey?: string;
  vertexExpressApiVersion?: string;
  geminiMockBaseUrl?: string;
  openRouterApiKey?: string;
  openRouterBaseUrl?: string;
  cerebrasApiKey?: string;
  cerebrasBaseUrl?: string;
  cerebrasWebSearchEnabled: boolean;
  modelStudioApiKey?: string;
  modelStudioBaseUrl?: string;
  modelStudioWebSearchEnabled: boolean;
  openRouterSiteUrl?: string;
  openRouterAppName?: string;
  openRouterWebSearchEnabled: boolean;
  openRouterWebSearchMaxResults: number;
  openRouterWebSearchMaxTotalResults?: number;
  openRouterWebSearchContextSize: "low" | "medium" | "high";
  ollamaApiKeys: string[];
  ollamaHost?: string;
  ollamaSearchHost?: string;
  ollamaWebSearchEnabled: boolean;
  ollamaWebFetchEnabled: boolean;
  ollamaWebSearchMaxResults: number;
  ollamaToolMaxIterations: number;
  webFetchEnabled: boolean;
  webFetchTimeoutMs: number;
  webFetchMaxBytes: number;
  webFetchMaxChars: number;
  webFetchMaxTotalChars: number;
  chatModel: string;
  chatMaxOutputTokens?: number;
  deliveryMaxOutputTokens?: number;
  deliveryRewriteEnabled: boolean;
  chatThinkingMode: "default" | "off" | "minimal" | "low" | "medium" | "high";
  embeddingProvider: "google" | "vertexexpress" | "ollama" | "openrouter";
  embeddingModel: string;
  openRouterEmbeddingModel?: string;
  indexPath: string;
  systemPrompt: string;
  personaProfile: "live" | "original";
  intimacyEnabled: boolean;
  intimacyFallbackProvider?: Settings["aiProvider"];
  intimacyFallbackModel?: string;
  memoryEnabled: boolean;
  memoryMaxMessages: number;
  memoryDir: string;
};

export function loadSettings(): Settings {
  const aiProvider = resolveAiProvider(
    process.env.PLANABRAIN_AI_PROVIDER ?? "google",
  );
  const googleApiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  const vertexExpressApiKey =
    readOptionalEnv("GOOGLE_VERTEX_EXPRESS_API_KEY") ??
    readOptionalEnv("VERTEX_EXPRESS_API_KEY");
  const vertexExpressApiVersion =
    readOptionalEnv("PLANABRAIN_VERTEX_EXPRESS_API_VERSION") ?? "v1";
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  const cerebrasApiKey = process.env.CEREBRAS_API_KEY?.trim();
  const modelStudioApiKey = process.env.MODEL_STUDIO_API_KEY?.trim();
  const ollamaApiKeys = resolveOllamaApiKeys();
  if (aiProvider === "google" && !googleApiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required when PLANABRAIN_AI_PROVIDER=google",
    );
  }
  if (aiProvider === "openrouter" && !openRouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when PLANABRAIN_AI_PROVIDER=openrouter",
    );
  }
  if (aiProvider === "vertexexpress" && !vertexExpressApiKey) {
    throw new Error(
      "GOOGLE_VERTEX_EXPRESS_API_KEY or VERTEX_EXPRESS_API_KEY is required when PLANABRAIN_AI_PROVIDER=vertexexpress",
    );
  }
  if (aiProvider === "ollama" && ollamaApiKeys.length === 0) {
    throw new Error(
      "OLLAMA_API_KEY or OLLAMA_API_KEYS is required when PLANABRAIN_AI_PROVIDER=ollama",
    );
  }
  if (aiProvider === "cerebras" && !cerebrasApiKey) {
    throw new Error(
      "CEREBRAS_API_KEY is required when PLANABRAIN_AI_PROVIDER=cerebras",
    );
  }
  if (aiProvider === "modelstudio" && !modelStudioApiKey) {
    throw new Error(
      "MODEL_STUDIO_API_KEY is required when PLANABRAIN_AI_PROVIDER=modelstudio",
    );
  }

  const indexPath =
    process.env.PLANABRAIN_INDEX_PATH ?? ".planabrain/index.json";
  const memoryEnabledRaw = process.env.PLANABRAIN_MEMORY_ENABLED;
  const memoryEnabled =
    memoryEnabledRaw == null
      ? true
      : !(
          memoryEnabledRaw === "0" || memoryEnabledRaw.toLowerCase() === "false"
        );

  const memoryMaxMessagesRaw =
    process.env.PLANABRAIN_MEMORY_MAX_MESSAGES ?? "20";
  const memoryMaxMessages = Math.max(
    0,
    Number.parseInt(memoryMaxMessagesRaw, 10) || 0,
  );

  const memoryDir =
    process.env.PLANABRAIN_MEMORY_DIR ??
    path.join(path.dirname(indexPath), "memory");

  const chatMaxOutputTokens = parseOptionalPositiveIntEnv(
    [
      "PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS",
      "PLANABRAIN_GEMINI_MAX_OUTPUT_TOKENS",
    ],
    2048,
  );
  const deliveryMaxOutputTokens = parseOptionalPositiveIntEnv(
    ["PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS"],
    1024,
  );
  const deliveryRewriteEnabled = parseBooleanEnv(
    "PLANABRAIN_DELIVERY_REWRITE_ENABLED",
    true,
  );
  const chatThinkingMode = resolveChatThinkingMode(aiProvider);
  const personaProfile = resolvePersonaProfile();
  const intimacyEnabled = parseBooleanEnv("PLANABRAIN_INTIMACY_ENABLED", true);
  const intimacyFallbackProvider = resolveOptionalAiProvider(
    "PLANABRAIN_INTIMACY_FALLBACK_PROVIDER",
  );
  const intimacyFallbackModel = readOptionalEnv(
    "PLANABRAIN_INTIMACY_FALLBACK_MODEL",
  );
  const embeddingProvider = resolveEmbeddingProvider(aiProvider);
  if (embeddingProvider === "openrouter" && !openRouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when PLANABRAIN_EMBEDDING_PROVIDER=openrouter",
    );
  }
  const openRouterWebSearchEnabled = parseBooleanEnv(
    "PLANABRAIN_OPENROUTER_ENABLE_WEB_SEARCH",
    true,
  );
  const openRouterWebSearchMaxResults = parseRequiredPositiveIntEnv(
    "PLANABRAIN_OPENROUTER_WEB_SEARCH_MAX_RESULTS",
    5,
  );
  const openRouterWebSearchMaxTotalResults = parseOptionalPositiveIntEnv(
    "PLANABRAIN_OPENROUTER_WEB_SEARCH_MAX_TOTAL_RESULTS",
    15,
  );
  const openRouterWebSearchContextSize = parseSearchContextSizeEnv(
    "PLANABRAIN_OPENROUTER_WEB_SEARCH_CONTEXT_SIZE",
    "medium",
  );
  const ollamaWebSearchEnabled = parseBooleanEnv(
    "PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH",
    false,
  );
  const cerebrasWebSearchEnabled = parseBooleanEnv(
    "PLANABRAIN_CEREBRAS_ENABLE_WEB_SEARCH",
    true,
  );
  const modelStudioWebSearchEnabled = parseBooleanEnv(
    "PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH",
    true,
  );
  const ollamaWebFetchEnabled = parseBooleanEnv(
    "PLANABRAIN_OLLAMA_ENABLE_WEB_FETCH",
    true,
  );
  const ollamaWebSearchMaxResults = parseRequiredPositiveIntEnv(
    "PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS",
    5,
  );
  const ollamaToolMaxIterations = parseRequiredPositiveIntEnv(
    "PLANABRAIN_OLLAMA_TOOL_MAX_ITERATIONS",
    4,
  );
  const webFetchEnabled = parseBooleanEnv(
    "PLANABRAIN_WEB_FETCH_ENABLED",
    true,
  );
  const webFetchTimeoutMs = parseBoundedPositiveIntEnv(
    "PLANABRAIN_WEB_FETCH_TIMEOUT_MS",
    10000,
    1000,
    30000,
  );
  const webFetchMaxBytes = parseBoundedPositiveIntEnv(
    "PLANABRAIN_WEB_FETCH_MAX_BYTES",
    1000000,
    1024,
    5000000,
  );
  const webFetchMaxChars = parseBoundedPositiveIntEnv(
    "PLANABRAIN_WEB_FETCH_MAX_CHARS",
    12000,
    500,
    50000,
  );
  const webFetchMaxTotalChars = parseBoundedPositiveIntEnv(
    "PLANABRAIN_WEB_FETCH_MAX_TOTAL_CHARS",
    18000,
    500,
    100000,
  );

  return {
    aiProvider,
    googleApiKey,
    vertexExpressApiKey,
    vertexExpressApiVersion,
    openRouterApiKey,
    cerebrasApiKey,
    cerebrasBaseUrl:
      aiProvider === "cerebras" || intimacyFallbackProvider === "cerebras"
        ? resolveCerebrasBaseUrl()
        : undefined,
    cerebrasWebSearchEnabled,
    modelStudioApiKey,
    modelStudioBaseUrl:
      aiProvider === "modelstudio" || intimacyFallbackProvider === "modelstudio"
        ? resolveModelStudioBaseUrl()
        : undefined,
    modelStudioWebSearchEnabled,
    ollamaApiKeys,
    geminiMockBaseUrl:
      aiProvider === "geminimock" || intimacyFallbackProvider === "geminimock"
        ? resolveGeminiMockBaseUrl()
        : undefined,
    openRouterBaseUrl:
      aiProvider === "openrouter" ||
      embeddingProvider === "openrouter" ||
      intimacyFallbackProvider === "openrouter"
        ? resolveOpenRouterBaseUrl()
        : undefined,
    openRouterSiteUrl:
      aiProvider === "openrouter"
        ? readOptionalEnv("PLANABRAIN_OPENROUTER_SITE_URL")
        : undefined,
    openRouterAppName:
      aiProvider === "openrouter"
        ? readOptionalEnv("PLANABRAIN_OPENROUTER_APP_NAME")
        : undefined,
    openRouterWebSearchEnabled,
    openRouterWebSearchMaxResults,
    openRouterWebSearchMaxTotalResults,
    openRouterWebSearchContextSize,
    ollamaHost:
      aiProvider === "ollama" || intimacyFallbackProvider === "ollama"
        ? resolveOllamaHost()
        : undefined,
    ollamaSearchHost:
      aiProvider === "ollama" || ollamaApiKeys.length > 0
        ? resolveOllamaSearchHost()
        : undefined,
    ollamaWebSearchEnabled,
    ollamaWebFetchEnabled,
    ollamaWebSearchMaxResults,
    ollamaToolMaxIterations,
    webFetchEnabled,
    webFetchTimeoutMs,
    webFetchMaxBytes,
    webFetchMaxChars,
    webFetchMaxTotalChars,
    chatModel:
      (aiProvider === "openrouter"
        ? process.env.PLANABRAIN_OPENROUTER_MODEL
        : aiProvider === "vertexexpress"
          ? process.env.PLANABRAIN_VERTEX_EXPRESS_MODEL
          : aiProvider === "ollama"
            ? process.env.PLANABRAIN_OLLAMA_MODEL
            : aiProvider === "cerebras"
              ? process.env.PLANABRAIN_CEREBRAS_MODEL
              : aiProvider === "modelstudio"
                ? process.env.PLANABRAIN_MODELSTUDIO_MODEL
                : undefined) ??
      process.env.PLANABRAIN_CHAT_MODEL ??
      process.env.PLANABRAIN_GEMINI_MODEL ??
      (aiProvider === "geminimock"
        ? (process.env.GEMINI_CLI_MODEL ?? "gemini-2.5-pro")
        : aiProvider === "openrouter"
          ? "openai/gpt-4o-mini"
          : aiProvider === "vertexexpress"
            ? "gemini-2.5-flash"
            : aiProvider === "ollama"
              ? "gemma4:31b-cloud"
              : aiProvider === "cerebras"
                ? "gemma-4-31b"
                : aiProvider === "modelstudio"
                  ? "qwen-plus"
                  : "gemini-3-flash-preview"),
    chatMaxOutputTokens,
    deliveryMaxOutputTokens,
    deliveryRewriteEnabled,
    embeddingModel:
      (aiProvider === "ollama"
        ? process.env.PLANABRAIN_OLLAMA_EMBEDDING_MODEL
        : undefined) ??
      (aiProvider === "vertexexpress"
        ? process.env.PLANABRAIN_VERTEX_EXPRESS_EMBEDDING_MODEL
        : undefined) ??
      (aiProvider === "google"
        ? process.env.PLANABRAIN_GEMINI_EMBEDDING_MODEL
        : undefined) ??
      process.env.PLANABRAIN_EMBEDDING_MODEL ??
      (aiProvider === "ollama"
        ? "embeddinggemma"
        : aiProvider === "vertexexpress"
          ? "gemini-embedding-001"
          : "gemini-embedding-001"),
    embeddingProvider,
    openRouterEmbeddingModel:
      embeddingProvider === "openrouter"
        ? (readOptionalEnv("PLANABRAIN_OPENROUTER_EMBEDDING_MODEL") ??
          "google/gemini-embedding-001")
        : undefined,
    indexPath,
    systemPrompt:
      process.env.PLANABRAIN_SYSTEM_PROMPT ??
      resolveDefaultSystemPrompt(personaProfile),
    personaProfile,
    intimacyEnabled,
    intimacyFallbackProvider,
    intimacyFallbackModel,
    memoryEnabled,
    memoryMaxMessages,
    memoryDir,
    chatThinkingMode,
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

function resolveOptionalAiProvider(
  key: string,
): Settings["aiProvider"] | undefined {
  const raw = process.env[key];
  if (raw == null || !raw.trim()) {
    return undefined;
  }
  return resolveAiProvider(raw);
}

function resolveAiProvider(
  raw: string,
):
  | "google"
  | "vertexexpress"
  | "geminimock"
  | "openrouter"
  | "ollama"
  | "cerebras"
  | "modelstudio" {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return "google";
  }
  if (
    normalized === "google" ||
    normalized === "google_cloud" ||
    normalized === "google-cloud"
  ) {
    return "google";
  }
  if (
    normalized === "vertexexpress" ||
    normalized === "vertex_express" ||
    normalized === "vertex-express" ||
    normalized === "google_vertex_express" ||
    normalized === "google-vertex-express"
  ) {
    return "vertexexpress";
  }
  if (normalized === "geminimock" || normalized === "mock") {
    return "geminimock";
  }
  if (normalized === "openrouter" || normalized === "open-router") {
    return "openrouter";
  }
  if (
    normalized === "ollama" ||
    normalized === "ollama_cloud" ||
    normalized === "ollama-cloud"
  ) {
    return "ollama";
  }
  if (normalized === "cerebras" || normalized === "cerebras-ai") {
    return "cerebras";
  }
  if (
    normalized === "modelstudio" ||
    normalized === "model_studio" ||
    normalized === "model-studio" ||
    normalized === "alibaba" ||
    normalized === "dashscope" ||
    normalized === "qwen"
  ) {
    return "modelstudio";
  }
  throw new Error(
    "PLANABRAIN_AI_PROVIDER must be one of: google, google_cloud, vertexexpress, vertex_express, vertex-express, geminimock, mock, openrouter, ollama, ollama_cloud, cerebras, modelstudio, alibaba, dashscope, qwen",
  );
}

function resolveEmbeddingProvider(
  aiProvider: Settings["aiProvider"],
): Settings["embeddingProvider"] {
  const raw = process.env.PLANABRAIN_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (raw) {
    if (raw === "openrouter" || raw === "open-router") {
      return "openrouter";
    }
    if (
      raw === "ollama" ||
      raw === "ollama_cloud" ||
      raw === "ollama-cloud"
    ) {
      return "ollama";
    }
    if (
      raw === "vertexexpress" ||
      raw === "vertex_express" ||
      raw === "vertex-express"
    ) {
      return "vertexexpress";
    }
    if (raw === "google" || raw === "google_cloud" || raw === "google-cloud") {
      return "google";
    }
    throw new Error(
      "PLANABRAIN_EMBEDDING_PROVIDER must be one of: google, vertexexpress, ollama, openrouter",
    );
  }
  if (aiProvider === "ollama") {
    return "ollama";
  }
  if (aiProvider === "vertexexpress") {
    return "vertexexpress";
  }
  return "google";
}

function resolveGeminiMockBaseUrl(): string {
  const explicit = process.env.PLANABRAIN_GEMINIMOCK_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const fromStatus = resolveGeminiMockBaseUrlFromStatus();
  if (fromStatus) {
    return fromStatus;
  }

  const host = process.env.GEMINI_CLI_API_HOST?.trim() || "127.0.0.1";
  const port = parseGeminiMockPort(
    process.env.GEMINI_CLI_API_PORT?.trim() || "43173",
  );
  const candidates = [
    `http://${host}:${port}`,
    "http://127.0.0.1:43173",
    "http://localhost:43173",
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "http://127.0.0.1:43173";
}

function resolveOpenRouterBaseUrl(): string {
  const explicit = readOptionalEnv("PLANABRAIN_OPENROUTER_BASE_URL");
  if (!explicit) {
    return "https://openrouter.ai/api/v1";
  }

  const normalized = normalizeApiBaseUrl(explicit);
  if (!normalized) {
    throw new Error(
      "PLANABRAIN_OPENROUTER_BASE_URL must be a valid http(s) URL",
    );
  }
  return normalized.endsWith("/api/v1") ? normalized : `${normalized}/api/v1`;
}

function resolveCerebrasBaseUrl(): string {
  const explicit = readOptionalEnv("PLANABRAIN_CEREBRAS_BASE_URL");
  if (!explicit) {
    return "https://api.cerebras.ai/v1";
  }
  const normalized = normalizeApiBaseUrl(explicit);
  if (!normalized) {
    throw new Error("PLANABRAIN_CEREBRAS_BASE_URL must be a valid http(s) URL");
  }
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

const MODEL_STUDIO_DEFAULT_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const MODEL_STUDIO_COMPATIBLE_PATH = "/compatible-mode/v1";

function resolveModelStudioBaseUrl(): string {
  const explicit = readOptionalEnv("PLANABRAIN_MODELSTUDIO_BASE_URL");
  if (!explicit) {
    return MODEL_STUDIO_DEFAULT_BASE_URL;
  }
  const normalized = normalizeApiBaseUrl(explicit);
  if (!normalized) {
    throw new Error(
      "PLANABRAIN_MODELSTUDIO_BASE_URL must be a valid http(s) URL",
    );
  }
  return normalized.endsWith(MODEL_STUDIO_COMPATIBLE_PATH)
    ? normalized
    : `${normalized}${MODEL_STUDIO_COMPATIBLE_PATH}`;
}

function resolveOllamaHost(): string {
  const explicit = readOptionalEnv("PLANABRAIN_OLLAMA_HOST");
  if (!explicit) {
    return "https://ollama.com";
  }
  const normalized = normalizeApiBaseUrl(explicit);
  if (!normalized) {
    throw new Error("PLANABRAIN_OLLAMA_HOST must be a valid http(s) URL");
  }
  return normalized;
}

function resolveOllamaSearchHost(): string {
  const explicit = readOptionalEnv("PLANABRAIN_OLLAMA_SEARCH_HOST");
  if (!explicit) {
    return "https://ollama.com";
  }
  const normalized = normalizeApiBaseUrl(explicit);
  if (!normalized) {
    throw new Error(
      "PLANABRAIN_OLLAMA_SEARCH_HOST must be a valid http(s) URL",
    );
  }
  return normalized;
}

function resolveOllamaApiKeys(): string[] {
  const values = [
    ...splitEnvList(process.env.OLLAMA_API_KEYS),
    ...splitEnvList(process.env.OLLAMA_API_KEY),
  ];
  const unique = new Set<string>();
  for (const value of values) {
    unique.add(value);
  }
  return Array.from(unique);
}

function resolveChatThinkingMode(
  aiProvider: Settings["aiProvider"],
): Settings["chatThinkingMode"] {
  const keys =
    aiProvider === "ollama"
      ? ["PLANABRAIN_OLLAMA_THINKING_MODE", "PLANABRAIN_CHAT_THINKING_MODE"]
      : aiProvider === "vertexexpress"
        ? [
            "PLANABRAIN_VERTEX_EXPRESS_THINKING_LEVEL",
            "PLANABRAIN_CHAT_THINKING_MODE",
          ]
        : aiProvider === "google" || aiProvider === "geminimock"
          ? [
              "PLANABRAIN_GEMINI_THINKING_LEVEL",
              "PLANABRAIN_CHAT_THINKING_MODE",
            ]
          : ["PLANABRAIN_CHAT_THINKING_MODE"];
  return parseThinkingModeEnv(keys, aiProvider === "vertexexpress");
}

function resolveGeminiMockBaseUrlFromStatus(): string | null {
  try {
    const output = execFileSync("geminimock", ["server", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1500,
    });
    const matched = output.match(/https?:\/\/[^\s"']+/g) ?? [];
    for (const raw of matched) {
      const normalized = normalizeBaseUrl(raw);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function normalizeApiBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

function parseGeminiMockPort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("GEMINI_CLI_API_PORT must be a positive integer");
  }
  return port;
}

function parseOptionalPositiveIntEnv(
  keys: string | string[],
  defaultValue: number,
): number | undefined {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const matchedKey = keyList.find((key) => process.env[key] != null);
  const raw = matchedKey ? process.env[matchedKey] : undefined;
  if (raw == null) {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "0" || trimmed.toLowerCase() === "false") {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${matchedKey ?? keyList[0]} must be a positive integer (or 0 to disable)`,
    );
  }
  return value;
}

function parseRequiredPositiveIntEnv(
  key: string,
  defaultValue: number,
): number {
  const raw = process.env[key];
  if (raw == null) {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return defaultValue;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function parseBoundedPositiveIntEnv(
  key: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  const value = parseRequiredPositiveIntEnv(key, defaultValue);
  if (value < minValue || value > maxValue) {
    throw new Error(`${key} must be between ${minValue} and ${maxValue}`);
  }
  return value;
}

function parseThinkingModeEnv(
  keys: string[],
  allowMinimal: boolean,
): Settings["chatThinkingMode"] {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw == null) {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (
      !normalized ||
      normalized === "default" ||
      normalized === "auto" ||
      normalized === "on"
    ) {
      return "default";
    }
    if (normalized === "off" || normalized === "none") {
      return "off";
    }
    if (normalized === "minimal") {
      if (allowMinimal) {
        return "minimal";
      }
      throw new Error(
        `${key} only supports "minimal" when PLANABRAIN_AI_PROVIDER=vertexexpress`,
      );
    }
    if (
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high"
    ) {
      return normalized;
    }
    throw new Error(
      `${key} must be one of: default, off, minimal, low, medium, high`,
    );
  }
  return "default";
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSearchContextSizeEnv(
  key: string,
  defaultValue: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  const raw = process.env[key];
  if (raw == null) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  throw new Error(`${key} must be one of: low, medium, high`);
}

function parseBooleanEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw == null) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  throw new Error(`${key} must be a boolean value`);
}

function readOptionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}
