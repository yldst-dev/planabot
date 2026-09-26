import { loadSettings, type Settings } from "../config/settings.js";
import { evaluateWithCodex } from "./codexJudge.js";
import { evaluateSystemOne, type DecisionEvaluator, type SystemOneConfig } from "./systemOne.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CODEX_TIMEOUT_MS = 8000;
const DISABLED_PROVIDERS = new Set(["off", "none", "rules"]);

export function loadDecisionConfig(env: NodeJS.ProcessEnv = process.env): SystemOneConfig | undefined {
  const provider = readProvider(env);
  if (provider && provider !== "jev") {
    return undefined;
  }
  const apiKey = env.PLANABRAIN_DECISION_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  return {
    apiKey,
    baseUrl: (env.PLANABRAIN_DECISION_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ""),
    model: env.PLANABRAIN_DECISION_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: readTimeout(env.PLANABRAIN_DECISION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 10_000),
  };
}

export function loadDecisionEvaluator(
  env: NodeJS.ProcessEnv = process.env,
  resolveSettings: () => Settings = loadSettings,
): DecisionEvaluator | undefined {
  if (DISABLED_PROVIDERS.has(readProvider(env))) {
    return undefined;
  }
  const jev = loadDecisionConfig(env);
  if (jev) {
    return jevEvaluator(jev);
  }
  let settings: Settings;
  try {
    settings = resolveSettings();
  } catch {
    return undefined;
  }
  if (!settings.codexApiKey || !settings.codexBaseUrl) {
    return undefined;
  }
  return codexEvaluator(settings, readTimeout(env.PLANABRAIN_DECISION_CODEX_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS, 30_000));
}

export function jevEvaluator(config: SystemOneConfig): DecisionEvaluator {
  return { name: "jev", evaluate: (state, questions) => evaluateSystemOne(config, state, questions) };
}

export function codexEvaluator(settings: Settings, timeoutMs = DEFAULT_CODEX_TIMEOUT_MS): DecisionEvaluator {
  return { name: "codex", evaluate: (state, questions) => evaluateWithCodex(settings, state, questions, timeoutMs) };
}

function readProvider(env: NodeJS.ProcessEnv): string {
  return env.PLANABRAIN_DECISION_PROVIDER?.trim().toLowerCase() ?? "";
}

function readTimeout(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 200 && value <= max ? value : fallback;
}
