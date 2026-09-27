import type { Settings } from "../config/settings.js";
import { loadMemoryConfig } from "../memory/config.js";
import { answerTurn, type RecentTurnInput, type TurnAnswer } from "../chat/webSearchAnswer.js";
import { runExecution } from "../runtime/execution.js";
import type { TurnSignals } from "../decision/turnSignals.js";
import { serial } from "../runtime/serial.js";
import { resolveTurnImages, type ImageFile } from "./turnImages.js";

export type AskInput = {
  requestId?: string;
  chatScope?: string;
  conversationId?: string;
  question: string;
  userId: string;
  currentTurnText?: string;
  memoryContext?: string;
  image?: ImageFile;
  images?: ImageFile[];
  imageNotice?: string;
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
  const { images, imageNotice } = await resolveTurnImages({
    files: [...(input.images ?? []), ...(input.image ? [input.image] : [])],
    notice: input.imageNotice,
    text: linkSourceText,
    settings,
    imageRoot,
  });
  return answerTurn({
    question,
    currentTurnText: linkSourceText,
    settings,
    userId: input.userId,
    chatScope: input.chatScope ?? "cli",
    conversationId: input.conversationId ?? input.userId,
    images,
    imageNotice,
    linkSourceText,
    memoryContext,
    recentTurns: input.recentTurns,
    continuousChat: input.continuousChat,
    signals: input.signals,
    workingTurnLimit: loadMemoryConfig().maxConversationTurns,
  });
}
