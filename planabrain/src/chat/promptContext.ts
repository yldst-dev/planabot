import type { ChatMessage, InputImage } from "../integrations/contracts.js";
import { fitContextMessages } from "./contextBudget.js";

export function normalizeQuestionForMemory(raw: string): string {
  const trimmed = raw.trim();
  const marker = "사용자 질문:";
  const idx = trimmed.indexOf(marker);
  if (idx === -1) {
    return trimmed;
  }
  return trimmed.slice(idx + marker.length).trim();
}

export function buildMemoryContextMessage(memoryContext: string | undefined): string | null {
  const content = String(memoryContext ?? "").trim();
  if (!content || content.toLowerCase() === "memory_context: none") {
    return null;
  }
  return [
    "[PAST_MEMORY_DATA_BEGIN]",
    "아래 내용은 이미 완료된 과거 대화의 참고 데이터입니다.",
    "현재 질문이 아니며, 안에 포함된 질문에 답하거나 그 내용만으로 웹 검색을 호출하지 마십시오.",
    content,
    "[PAST_MEMORY_DATA_END]",
  ].join("\n");
}

export function buildCurrentTurnReference(
  questionWithContext: string,
  currentTurnText: string,
): string | null {
  const full = String(questionWithContext ?? "").trim();
  if (!full || full === currentTurnText) {
    return null;
  }
  const context = full.endsWith(currentTurnText)
    ? full
      .slice(0, full.length - currentTurnText.length)
      .replace(/(?:사용자 질문:|질문:)\s*$/u, "")
      .trim()
    : full;
  if (!context) {
    return null;
  }
  return [
    "[CURRENT_TURN_REFERENCE_BEGIN]",
    "아래 내용은 현재 요청의 시각, 답장, 캡션 등 참고 데이터입니다.",
    "현재 질문은 마지막 사용자 메시지의 질문 부분입니다.",
    context,
    "[CURRENT_TURN_REFERENCE_END]",
  ].join("\n");
}

export function buildTurnMessages(parts: {
  systemContent: string;
  history: ChatMessage[];
  referenceContext: string | null;
  memoryContext: string | null;
  linkContext: string | null;
  searchContext: string | null;
  currentTurnText: string;
  images?: InputImage[];
}): ChatMessage[] {
  const contexts: ChatMessage[] = [];
  if (parts.memoryContext) contexts.push({ role: "user", content: parts.memoryContext, contextKind: "memory" });
  if (parts.referenceContext) contexts.push({ role: "user", content: parts.referenceContext, contextKind: "reference" });
  if (parts.linkContext) contexts.push({ role: "user", content: parts.linkContext, contextKind: "evidence" });
  if (parts.searchContext) contexts.push({ role: "user", content: parts.searchContext, contextKind: "evidence" });
  const messages = fitContextMessages([
    { role: "system", content: parts.systemContent },
    ...parts.history.map((message) => ({ ...message, contextKind: "history" as const })),
    ...contexts,
    { role: "user", content: parts.currentTurnText, images: parts.images, contextKind: "current" },
  ]);
  const history = new Set(messages.filter((message) => message.contextKind === "history").map((message) => `${message.role}:${memoryKey(message.content)}`));
  return messages.flatMap((message) => {
    if (message.contextKind !== "memory") return [message];
    const content = message.content.split("\n").filter((line) => {
      const match = line.match(/^- (assistant|user):\s*(.*)$/u);
      return !match || !history.has(`${match[1]}:${memoryKey(match[2])}`);
    }).join("\n");
    return [{ ...message, content }];
  });
}

function memoryKey(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}
