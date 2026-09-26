import path from "node:path";
import { open, realpath } from "node:fs/promises";
import type { Settings } from "../config/settings.js";
import type { InputImage } from "../integrations/chat.js";
import { loadMemoryConfig } from "../memory/config.js";
import { answerTurn, type RecentTurnInput, type TurnAnswer } from "../chat/webSearchAnswer.js";
import { runExecution } from "../runtime/execution.js";
import type { TurnSignals } from "../decision/turnSignals.js";
import { serial } from "../runtime/serial.js";

export type AskInput = {
  requestId?: string;
  chatScope?: string;
  conversationId?: string;
  question: string;
  userId: string;
  currentTurnText?: string;
  memoryContext?: string;
  image?: { path: string; mimeType?: string; };
  recentTurns?: RecentTurnInput[];
  continuousChat?: boolean;
  signals?: TurnSignals;
};

export async function runAsk(input: AskInput, settings: Settings, imageRoot?: string): Promise<TurnAnswer> {
  return runExecution("ask", () => serial(JSON.stringify(["turn", input.chatScope ?? "cli", input.conversationId ?? input.userId]), () => executeAsk(input, settings, imageRoot)), { requestId: input.requestId });
}

async function executeAsk(input: AskInput, settings: Settings, imageRoot?: string): Promise<TurnAnswer> {
  const question = input.question.trim();
  if (!question) {
    throw new Error("질문이 비어 있습니다");
  }
  const linkSourceText = input.currentTurnText?.trim() || question;
  const memoryContext = input.memoryContext?.trim() || undefined;
  const images = await resolveImages(input.image, imageRoot);
  return answerTurn({
    question,
    currentTurnText: linkSourceText,
    settings,
    userId: input.userId,
    chatScope: input.chatScope ?? "cli",
    conversationId: input.conversationId ?? input.userId,
    images,
    linkSourceText,
    memoryContext,
    recentTurns: input.recentTurns,
    continuousChat: input.continuousChat,
    signals: input.signals,
    workingTurnLimit: loadMemoryConfig().maxConversationTurns,
  });
}

async function resolveImages(
  image: AskInput["image"],
  imageRoot?: string,
): Promise<InputImage[] | undefined> {
  if (!image?.path) {
    return undefined;
  }
  const mimeType = image.mimeType?.trim() || "image/jpeg";
  try {
    const resolved = await realpath(image.path);
    if (imageRoot) {
      const relative = path.relative(await realpath(imageRoot), resolved);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("허용된 이미지 폴더가 아닙니다.");
    }
    const handle = await open(resolved, "r");
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("이미지 파일은 10MB 이하여야 합니다.");
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) throw new Error("지원하지 않는 이미지 형식입니다.");
    const valid = mimeType === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === "image/gif" ? /GIF8[79]a/u.test(bytes.subarray(0, 6).toString("ascii"))
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid) throw new Error("이미지 내용과 파일 형식이 일치하지 않습니다.");
    return [{ data: bytes.toString("base64"), mimeType }];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`이미지 파일 읽기 실패: ${message}`);
  }
}
