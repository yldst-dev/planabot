import { estimateTokenCount } from "tokenx";
import type { ChatMessage } from "../integrations/chat.js";
import { estimateTokens } from "../memoryflow/token-estimator.js";
import { ExecutionLimitError } from "../runtime/execution.js";

export const MAX_CONTEXT_TOKENS = 24_000;

export function messageTokens(message: ChatMessage): number {
  return 8 + Math.max(estimateTokens(message.content), estimateTokenCount(message.content), Math.ceil(message.content.length / 4)) + (message.images?.length ?? 0) * 4096;
}

export function contextTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

export function fitContextMessages(messages: ChatMessage[], preserveReplay = false): ChatMessage[] {
  const result = [...messages];
  const sizes = result.map(messageTokens);
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
  if (total > MAX_CONTEXT_TOKENS) {
    throw new ExecutionLimitError("질문과 참고 자료가 너무 깁니다. 내용을 나누어 보내 주세요.");
  }
  return result;
}
