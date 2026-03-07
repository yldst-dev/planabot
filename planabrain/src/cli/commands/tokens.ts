import { readFile } from "node:fs/promises";
import { estimateTokenCount, type TokenEstimationOptions } from "tokenx";

type ModelProfile = {
  name: string;
  options: TokenEstimationOptions;
};

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

  const profile = resolveModelProfile(model);
  const multiplier = resolveSafetyMultiplier();
  const rawTokens = estimateTokenCount(text, profile.options);
  const adjustedTokens = Math.max(1, Math.ceil(rawTokens * multiplier));

  process.stdout.write(
    `${JSON.stringify({
      tokens: adjustedTokens,
      rawTokens,
      estimator: "tokenx",
      model,
      profile: profile.name,
      defaultCharsPerToken: profile.options.defaultCharsPerToken,
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
    process.env.PLANABRAIN_OPENROUTER_MODEL ??
    process.env.PLANABRAIN_CHAT_MODEL ??
    process.env.PLANABRAIN_GEMINI_MODEL ??
    process.env.GEMINI_CLI_MODEL;
  if (fromEnv && fromEnv.trim()) {
    return stripModelPrefix(fromEnv);
  }

  return "unknown";
}

function stripModelPrefix(model: string): string {
  return model.trim().replace(/^models\//, "");
}

function resolveModelProfile(model: string): ModelProfile {
  const value = model.toLowerCase();

  if (
    value.includes("gpt") ||
    value.includes("openai") ||
    value.includes("o1") ||
    value.includes("o3") ||
    value.includes("o4")
  ) {
    return {
      name: "openai",
      options: { defaultCharsPerToken: 4 },
    };
  }

  if (value.includes("claude") || value.includes("anthropic")) {
    return {
      name: "anthropic",
      options: { defaultCharsPerToken: 4 },
    };
  }

  if (value.includes("gemini") || value.includes("google")) {
    return {
      name: "gemini",
      options: { defaultCharsPerToken: 4 },
    };
  }

  if (
    value.includes("llama") ||
    value.includes("mistral") ||
    value.includes("mixtral") ||
    value.includes("deepseek") ||
    value.includes("qwen") ||
    value.includes("phi") ||
    value.includes("grok")
  ) {
    return {
      name: "open",
      options: { defaultCharsPerToken: 4 },
    };
  }

  return {
    name: "generic",
    options: { defaultCharsPerToken: 4 },
  };
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
