import { readFile } from "node:fs/promises";

import type { Settings } from "../../config/settings.js";
import { normalizeWireMessages } from "../../memory/database.js";
import { forgetMemory, listMemories, rememberExchange, resetAllMemory, resetUserMemory } from "../../memory/service.js";

const EXCHANGE_USAGE = "Usage: planabrain memory-exchange <userId> <chatId> <userText> <assistantText>";

export async function runMemoryExchangeCommand(args: string[], settings: Settings): Promise<void> {
  const [userId, chatId, userTextArg, assistantTextArg, ...rest] = args;
  ensure(Boolean(userId && chatId) && rest.length === 0, EXCHANGE_USAGE);
  const userText = await resolveExchangeText(userTextArg, "PLANABRAIN_LOCAL_MEMORY_USER_TEXT_FILE");
  const assistantText = await resolveExchangeText(assistantTextArg, "PLANABRAIN_LOCAL_MEMORY_ASSISTANT_TEXT_FILE");
  const transcript = readTranscript(process.env.PLANABRAIN_TRANSCRIPT_JSON);
  const result = await rememberExchange(
    {
      userId: String(userId),
      chatId: String(chatId),
      requestId: process.env.PLANABRAIN_REQUEST_ID?.trim() || undefined,
      conversationId: process.env.PLANABRAIN_CONVERSATION_ID?.trim() || undefined,
      userText,
      assistantText,
      ...transcript,
    },
    { settings, background: false },
  );
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

export async function runMemoryListCommand(args: string[]): Promise<void> {
  const [userId, chatId] = args;
  ensure(Boolean(userId && chatId), "Usage: planabrain memory-list <userId> <chatId>");
  const memories = listMemories(String(userId), String(chatId)).map(({ id, kind, content }) => ({ id, kind, content }));
  process.stdout.write(`${JSON.stringify({ memories })}\n`);
}

export async function runMemoryForgetCommand(args: string[]): Promise<void> {
  const [userId, chatId, rawId] = args;
  const id = Number.parseInt(String(rawId ?? ""), 10);
  ensure(Boolean(userId && chatId) && Number.isSafeInteger(id) && id > 0, "Usage: planabrain memory-forget <userId> <chatId> <memoryId>");
  process.stdout.write(`${JSON.stringify({ removed: forgetMemory(String(userId), String(chatId), id) })}\n`);
}

export async function runMemoryResetUserCommand(args: string[]): Promise<void> {
  const [userId] = args;
  ensure(Boolean(userId), "Usage: planabrain memory-reset-user <userId>");
  process.stdout.write(`${JSON.stringify({ userId, removed: resetUserMemory(String(userId)) })}\n`);
}

export async function runMemoryResetAllCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify({ removed: resetAllMemory() })}\n`);
}

function readTranscript(raw: string | undefined): { wireMessages?: ReturnType<typeof normalizeWireMessages>; epoch?: number; } {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as { wireMessages?: unknown; epoch?: unknown; };
    const wireMessages = normalizeWireMessages(parsed.wireMessages);
    const epoch = typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch) && parsed.epoch >= 0 ? parsed.epoch : undefined;
    return { ...(wireMessages ? { wireMessages } : {}), ...(epoch === undefined ? {} : { epoch }) };
  } catch {
    return {};
  }
}

async function resolveExchangeText(arg: string | undefined, fileEnv: string): Promise<string> {
  let text = String(arg ?? "").trim();
  const textFile = process.env[fileEnv];
  if (!text && textFile) {
    try {
      text = (await readFile(textFile, "utf8")).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`메모리 교환 텍스트 파일 읽기 실패: ${message}`);
    }
  }
  ensure(Boolean(text), EXCHANGE_USAGE);
  return text;
}

function ensure(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
