import { readFile } from "node:fs/promises";

import { migrateJsonMemoryToSqlite } from "../../memoryflow/migrate-json.js";
import { LocalMemoryEngine } from "../../memoryflow/memory-engine.js";

export async function runMemoryPrepareCommand(args: string[]): Promise<void> {
  const [userId, chatId, ...parts] = args;
  ensure(Boolean(userId && chatId), "Usage: planabrain memory-prepare <userId> <chatId> <text> [tokenBudget]");
  const conversationId = readConversationId();

  const { textParts, budget } = splitTextAndBudget(parts);
  const text = await resolveTextFromArgs(
    textParts,
    "Usage: planabrain memory-prepare <userId> <chatId> <text> [tokenBudget]"
  );

  const engine = new LocalMemoryEngine();
  try {
    const prepared = await engine.preparePromptInput({
      userId: String(userId),
      chatId: String(chatId),
      conversationId,
      userText: text,
      tokenBudget: budget
    });
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
  } finally {
    engine.close();
  }
}

export async function runMemoryAssistantCommand(args: string[]): Promise<void> {
  const [userId, chatId, ...parts] = args;
  ensure(Boolean(userId && chatId), "Usage: planabrain memory-assistant <userId> <chatId> <text>");
  const conversationId = readConversationId();
  const text = await resolveTextFromArgs(
    parts,
    "Usage: planabrain memory-assistant <userId> <chatId> <text>"
  );

  const engine = new LocalMemoryEngine();
  try {
    const result = await engine.rememberAssistantTurn({
      userId: String(userId),
      chatId: String(chatId),
      conversationId,
      assistantText: text
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    engine.close();
  }
}

export async function runMemoryResetUserCommand(args: string[]): Promise<void> {
  const [userId] = args;
  ensure(Boolean(userId), "Usage: planabrain memory-reset-user <userId>");

  const engine = new LocalMemoryEngine();
  try {
    const result = await engine.resetUser(String(userId));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    engine.close();
  }
}

export async function runMemoryMigrateJsonCommand(args: string[]): Promise<void> {
  const [sourceDir] = args;
  const result = await migrateJsonMemoryToSqlite({
    sourceDir: sourceDir ? String(sourceDir) : undefined
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function splitTextAndBudget(parts: string[]): {
  textParts: string[];
  budget: number | undefined;
} {
  const maybeBudget = parts.at(-1);
  const parsed = Number.parseInt(String(maybeBudget), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return {
      textParts: parts.slice(0, -1),
      budget: parsed
    };
  }
  return {
    textParts: parts,
    budget: undefined
  };
}

async function resolveTextFromArgs(parts: string[], usage: string): Promise<string> {
  let text = parts.join(" ").trim();
  if (text) {
    return text;
  }

  const textFile = process.env.PLANABRAIN_LOCAL_MEMORY_TEXT_FILE;
  if (textFile) {
    try {
      text = (await readFile(textFile, "utf8")).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`메모리 텍스트 파일 읽기 실패: ${message}`);
    }
  }

  ensure(Boolean(text), usage);
  return text;
}

function ensure(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function readConversationId(): string | undefined {
  const value = process.env.PLANABRAIN_CONVERSATION_ID?.trim();
  return value ? value : undefined;
}
