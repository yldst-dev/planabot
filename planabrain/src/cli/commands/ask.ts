import { readFile } from "node:fs/promises";

import type { Settings } from "../../config/settings.js";
import type { InputImage } from "../../integrations/chat.js";
import { loadConfig as loadMemoryConfig } from "../../memoryflow/config.js";
import {
  answerTurn,
  type RecentTurnInput,
  type TurnAnswer,
} from "../../chat/webSearchAnswer.js";

export type AskInput = {
  question: string;
  userId: string;
  currentTurnText?: string;
  memoryContext?: string;
  image?: { path: string; mimeType?: string };
  memoryEnabled?: boolean;
  recentTurns?: RecentTurnInput[];
  continuousChat?: boolean;
};

export async function runAsk(input: AskInput, settings: Settings): Promise<TurnAnswer> {
  const question = input.question.trim();
  if (!question) {
    throw new Error("질문이 비어 있습니다");
  }
  const linkSourceText = input.currentTurnText?.trim() || question;
  const memoryContext = input.memoryContext?.trim() || undefined;
  const images = await resolveImages(input.image);
  const effectiveSettings =
    input.memoryEnabled === false ? { ...settings, memoryEnabled: false } : settings;
  return answerTurn({
    question,
    currentTurnText: linkSourceText,
    settings: effectiveSettings,
    userId: input.userId,
    images,
    linkSourceText,
    memoryContext,
    recentTurns: input.recentTurns,
    continuousChat: input.continuousChat,
    workingTurnLimit: loadMemoryConfig().maxWorkingTurns,
  });
}

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
      currentTurnText: process.env.PLANABRAIN_CURRENT_TURN_TEXT,
      memoryContext: process.env.PLANABRAIN_MEMORY_CONTEXT,
      image: imageFile
        ? { path: imageFile, mimeType: process.env.PLANABRAIN_IMAGE_MIME_TYPE?.trim() }
        : undefined,
      recentTurns: await readRecentTurnsFile(process.env.PLANABRAIN_RECENT_TURNS_FILE),
    },
    settings,
  );
  process.stdout.write(`${result.answer}\n`);
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

async function resolveImages(
  image: AskInput["image"],
): Promise<InputImage[] | undefined> {
  if (!image?.path) {
    return undefined;
  }
  const mimeType = image.mimeType?.trim() || "image/jpeg";
  try {
    const bytes = await readFile(image.path);
    return [{ data: bytes.toString("base64"), mimeType }];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`이미지 파일 읽기 실패: ${message}`);
  }
}
