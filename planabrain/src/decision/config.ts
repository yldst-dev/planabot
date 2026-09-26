import type { SystemOneConfig } from "./systemOne.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const DEFAULT_TIMEOUT_MS = 2500;

export function loadDecisionConfig(env: NodeJS.ProcessEnv = process.env): SystemOneConfig | undefined {
  if (env.PLANABRAIN_DECISION_PROVIDER?.trim().toLowerCase() !== "jev") {
    return undefined;
  }
  const apiKey = env.PLANABRAIN_DECISION_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  const timeoutMs = Number(env.PLANABRAIN_DECISION_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl: (env.PLANABRAIN_DECISION_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/u, ""),
    model: env.PLANABRAIN_DECISION_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 200 && timeoutMs <= 10_000 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}
