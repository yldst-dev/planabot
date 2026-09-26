import { readFile } from "node:fs/promises";
import type { Settings } from "../../config/settings.js";
import type { RecentTurnInput } from "../../chat/webSearchAnswer.js";
import { runAsk } from "../../application/turnService.js";
import { parseTurnSignals } from "../../decision/turnSignals.js";
export { runAsk, type AskInput } from "../../application/turnService.js";

export async function runAskCommand(args: string[], settings: Settings): Promise<void> {
  let question = args.join(" ").trim();
  if (!question) {
    const questionFile = process.env.PLANABRAIN_QUESTION_FILE;
    if (questionFile) {
      try {
        question = (await readFile(questionFile, "utf8")).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PLANABRAIN_QUESTION_FILE 읽기 실패: ${message}`);
      }
    }
  }
  if (!question) {
    throw new Error("Usage: planabrain ask <question>");
  }

  const imageFile = process.env.PLANABRAIN_IMAGE_FILE?.trim();
  const result = await runAsk(
    {
      question,
      userId: process.env.PLANABRAIN_USER_ID ?? "cli",
      requestId: process.env.PLANABRAIN_REQUEST_ID,
      chatScope: process.env.PLANABRAIN_CHAT_SCOPE,
      conversationId: process.env.PLANABRAIN_CONVERSATION_ID,
      currentTurnText: process.env.PLANABRAIN_CURRENT_TURN_TEXT,
      memoryContext: process.env.PLANABRAIN_MEMORY_CONTEXT,
      image: imageFile
        ? { path: imageFile, mimeType: process.env.PLANABRAIN_IMAGE_MIME_TYPE?.trim() }
        : undefined,
      recentTurns: await readRecentTurnsFile(process.env.PLANABRAIN_RECENT_TURNS_FILE),
      signals: readSignals(process.env.PLANABRAIN_TURN_SIGNALS),
    },
    settings,
  );
  process.stdout.write(`${process.env.PLANABRAIN_OUTPUT_JSON === "1" ? JSON.stringify(result) : result.answer}\n`);
}

function readSignals(raw: string | undefined): ReturnType<typeof parseTurnSignals> {
  try {
    return raw?.trim() ? parseTurnSignals(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

async function readRecentTurnsFile(path: string | undefined): Promise<RecentTurnInput[] | undefined> {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(trimmed, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as RecentTurnInput[]) : undefined;
  } catch {
    return undefined;
  }
}
