import assert from "node:assert/strict";
import test from "node:test";

import { runTokensCommand } from "./tokens.js";

const KEYS = ["PLANABOT_TOKEN_ESTIMATE_MULTIPLIER", "PLANABOT_TOKEN_MODEL", "PLANABRAIN_CODEX_MODEL", "PLANABOT_TOKEN_TEXT_FILE"] as const;

async function runTokens(args: string[], env: Partial<Record<(typeof KEYS)[number], string>> = {}): Promise<string> {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runTokensCommand(args);
  } finally {
    process.stdout.write = original;
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  return written.join("");
}

const TEXT = "프라나야, 오늘 날씨 알려줘. Please summarize the release notes.";

test("tokens prints the same JSON line for a known model name", async () => {
  assert.equal(
    await runTokens(["models/gpt-6-astra", TEXT]),
    "{\"tokens\":24,\"rawTokens\":24,\"estimator\":\"tokenx\",\"model\":\"gpt-6-astra\",\"profile\":\"openai\",\"defaultCharsPerToken\":4,\"multiplier\":1}\n",
  );
});

test("tokens prints the same JSON line when no model is known", async () => {
  assert.equal(
    await runTokens(["", TEXT]),
    "{\"tokens\":24,\"rawTokens\":24,\"estimator\":\"tokenx\",\"model\":\"unknown\",\"profile\":\"generic\",\"defaultCharsPerToken\":4,\"multiplier\":1}\n",
  );
});

test("the model name does not change the token count and the multiplier scales it", async () => {
  const counts = new Set<number>();
  const profiles: string[] = [];
  for (const model of ["claude-opus-5-5", "gemini-3", "qwen3", "unknown", "gpt-6-astra"]) {
    const output = JSON.parse(await runTokens([model, TEXT])) as { tokens: number; profile: string; };
    counts.add(output.tokens);
    profiles.push(output.profile);
  }
  assert.equal(counts.size, 1);
  assert.deepEqual(profiles, ["anthropic", "gemini", "open", "generic", "openai"]);
  const scaled = JSON.parse(await runTokens(["gpt-6-astra", TEXT], { PLANABOT_TOKEN_ESTIMATE_MULTIPLIER: "2" })) as { tokens: number; rawTokens: number; multiplier: number; };
  assert.deepEqual([scaled.rawTokens, scaled.tokens, scaled.multiplier], [24, 48, 2]);
});
