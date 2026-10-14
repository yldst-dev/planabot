import { estimateTokenCount } from "tokenx";
import type { ChatMessage } from "../integrations/chat.js";
import { estimateTokens } from "../runtime/tokens.js";
import { ExecutionLimitError } from "../runtime/execution.js";

export const MAX_CONTEXT_TOKENS = 24_000;
export const DEFAULT_IMAGE_TOKENS = 4096;
const LOW_DETAIL_IMAGE_TOKENS = 256;
const MIN_EVIDENCE_CHARS = 500;

export function imageTokenEstimate(detail: string | undefined): number {
  return detail === "low" ? LOW_DETAIL_IMAGE_TOKENS : DEFAULT_IMAGE_TOKENS;
}

export function messageTokens(message: ChatMessage, imageTokens = DEFAULT_IMAGE_TOKENS): number {
  return 8 + Math.max(estimateTokens(message.content), estimateTokenCount(message.content), Math.ceil(message.content.length / 4)) + (message.images?.length ?? 0) * imageTokens;
}

export function contextTokens(messages: ChatMessage[], imageTokens = DEFAULT_IMAGE_TOKENS): number {
  return messages.reduce((total, message) => total + messageTokens(message, imageTokens), 0);
}

export function fitContextMessages(messages: ChatMessage[], preserveReplay = false, imageTokens = DEFAULT_IMAGE_TOKENS): ChatMessage[] {
  const result = [...messages];
  const sizes = result.map((message) => messageTokens(message, imageTokens));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const lastUser = [...result].reverse().find((message) => message.role === "user");
  const removable = (message: ChatMessage): boolean =>
    message !== lastUser &&
    (message.role === "user" || message.role === "assistant") &&
    (message.contextKind === undefined || message.contextKind === "history" || message.contextKind === "memory");
  while (!preserveReplay && total > MAX_CONTEXT_TOKENS) {
    let index = result.findIndex((message) => removable(message) && message.contextKind !== "memory");
    if (index < 0) index = result.findIndex(removable);
    if (index < 0) break;
    const paired = result[index].role === "user" && result[index + 1]?.role === "assistant" && removable(result[index + 1]);
    const count = paired ? 2 : 1;
    total -= sizes.splice(index, count).reduce((sum, size) => sum + size, 0);
    result.splice(index, count);
  }
  while (total > MAX_CONTEXT_TOKENS) {
    let index = -1;
    result.forEach((message, position) => {
      if (message.contextKind === "evidence" && message.content.length > MIN_EVIDENCE_CHARS && (index < 0 || sizes[position] > sizes[index])) index = position;
    });
    if (index < 0) break;
    const message = result[index];
    const keep = Math.max(MIN_EVIDENCE_CHARS, message.content.length - Math.ceil((total - MAX_CONTEXT_TOKENS) * 1.1) - 1);
    result[index] = { ...message, content: message.content.slice(0, keep) };
    const size = messageTokens(result[index], imageTokens);
    total += size - sizes[index];
    sizes[index] = size;
  }
  if (total > MAX_CONTEXT_TOKENS) {
    throw new ExecutionLimitError("질문과 참고 자료가 너무 깁니다. 내용을 나누어 보내 주십시오.");
  }
  return result;
}
