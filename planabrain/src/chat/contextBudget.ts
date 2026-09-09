import { estimateTokenCount } from "tokenx";
import type { ChatMessage } from "../integrations/chat.js";
import { estimateTokens } from "../memoryflow/token-estimator.js";
import { ExecutionLimitError } from "../runtime/execution.js";

export const MAX_CONTEXT_TOKENS = 24_000;

export function contextTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + 8 + Math.max(estimateTokens(message.content), estimateTokenCount(message.content), Math.ceil(message.content.length / 4)) + (message.images?.length ?? 0) * 4096, 0);
}

export function fitContextMessages(messages: ChatMessage[], preserveReplay = false): ChatMessage[] {
  const result = [...messages];
  if (!preserveReplay) {
    while (contextTokens(result) > MAX_CONTEXT_TOKENS && result.length > 2) {
      const first = result[1];
      if (first.role === "system" || first.role === "developer") break;
      result.splice(1, first.role === "user" && result[2]?.role === "assistant" ? 2 : 1);
    }
  }
  if (contextTokens(result) > MAX_CONTEXT_TOKENS) {
    throw new ExecutionLimitError("질문과 참고 자료가 너무 깁니다. 내용을 나누어 보내 주세요.");
  }
  return result;
}
