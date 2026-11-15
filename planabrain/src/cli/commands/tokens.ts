import { readFile } from "node:fs/promises";
import { estimateTokenCount } from "tokenx";

const DEFAULT_CHARS_PER_TOKEN = 4;

const PROFILE_LABELS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["openai", ["gpt", "openai", "o1", "o3", "o4"]],
  ["anthropic", ["claude", "anthropic"]],
  ["gemini", ["gemini", "google"]],
  ["open", ["llama", "mistral", "mixtral", "deepseek", "qwen", "phi", "grok"]],
];

export async function runTokensCommand(args: string[]): Promise<void> {
  const explicitModel = args[0]?.trim() ?? "";
  const model = resolveTokenModel(explicitModel);
  let text = args.slice(1).join(" ").trim();

  if (!text) {
    const textFile = process.env.PLANABOT_TOKEN_TEXT_FILE;
    if (textFile) {
      try {
        text = (await readFile(textFile, "utf8")).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PLANABOT_TOKEN_TEXT_FILE 읽기 실패: ${message}`);
      }
    }
  }

  if (!text) {
    throw new Error("Usage: planabrain tokens <model> <text>");
  }

  const multiplier = resolveSafetyMultiplier();
  const rawTokens = estimateTokenCount(text, { defaultCharsPerToken: DEFAULT_CHARS_PER_TOKEN });
  const adjustedTokens = Math.max(1, Math.ceil(rawTokens * multiplier));

  process.stdout.write(
    `${JSON.stringify({
      tokens: adjustedTokens,
      rawTokens,
      estimator: "tokenx",
      model,
      profile: resolveProfileLabel(model),
      defaultCharsPerToken: DEFAULT_CHARS_PER_TOKEN,
      multiplier,
    })}\n`,
  );
}

function resolveTokenModel(explicit: string): string {
  if (explicit) {
    return stripModelPrefix(explicit);
  }

  const fromEnv =
    process.env.PLANABOT_TOKEN_MODEL ??
    process.env.PLANABRAIN_CODEX_MODEL;
  if (fromEnv && fromEnv.trim()) {
    return stripModelPrefix(fromEnv);
  }

  return "unknown";
}

function stripModelPrefix(model: string): string {
  return model.trim().replace(/^models\//, "");
}

function resolveProfileLabel(model: string): string {
  const value = model.toLowerCase();
  return PROFILE_LABELS.find(([, needles]) => needles.some((needle) => value.includes(needle)))?.[0] ?? "generic";
}

function resolveSafetyMultiplier(): number {
  const raw = process.env.PLANABOT_TOKEN_ESTIMATE_MULTIPLIER;
  if (!raw) {
    return 1;
  }

  const value = Number.parseFloat(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return value;
}
