import { type Settings } from "../../config/settings.js";
import { type ChatMessage, type ChatInvocationResult } from "../contracts.js";
import { buildWebTools, extractOllamaToolCalls, executeOllamaToolCall } from "../tools/webTools.js";
import { WebToolPolicy } from "../webToolPolicy.js";
import { withRateLimitRetry } from "../retry.js";
import { invokeOllamaApi } from "../ollama/api.js";
import { readUsage } from "../responseMetadata.js";
import { ProviderApiError } from "../providerError.js";
import { withWebToolCitations } from "../evidence.js";
import { asRecord } from "../value.js";

export async function invokeOllamaChat(
  settings: Settings,
  messages: ChatMessage[],
  enableSearchTool: boolean | undefined,
  webFetchUrlSource: string | undefined,
): Promise<ChatInvocationResult> {
  const normalizedMessages = messages.map((message) => toOllamaMessage(message));
  const webSearchAvailable = Boolean(enableSearchTool && settings.ollamaWebSearchEnabled);
  const webFetchAvailable = Boolean(
    enableSearchTool && settings.ollamaWebFetchEnabled && settings.webFetchEnabled,
  );
  const tools = buildWebTools(webSearchAvailable, webFetchAvailable);
  const maxIterations = Math.max(1, settings.ollamaToolMaxIterations);
  let workingMessages = normalizedMessages;
  const webToolPolicy = new WebToolPolicy(webFetchUrlSource ?? "");

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const payload: Record<string, unknown> = {
      model: settings.chatModel,
      stream: false,
      messages: workingMessages,
    };
    const ollamaThinkingMode = buildOllamaThinkingMode(
      settings.chatThinkingMode,
    );
    if (ollamaThinkingMode !== undefined) {
      payload.think = ollamaThinkingMode;
    }
    if (tools) {
      payload.tools = tools;
    }
    if (settings.chatMaxOutputTokens) {
      payload.options = {
        num_predict: settings.chatMaxOutputTokens,
      };
    }

    const response = await withRateLimitRetry(() =>
      invokeOllamaApi({
        providerName: "Ollama",
        host: settings.ollamaHost,
        apiKeys: settings.ollamaApiKeys,
        path: "/api/chat",
        payload,
      }),
    );
    readUsage(response);
    const message = extractOllamaMessage(response);
    const toolCalls = extractOllamaToolCalls(message);
    if (toolCalls.length === 0) {
      const content = normalizeOllamaContent(message.content);
      if (!content) {
        throw new ProviderApiError({
          kind: "empty_or_filtered",
          provider: "Ollama",
          status: 200,
          message: "Ollama API response missing message.content",
        });
      }
      return withWebToolCitations(
        {
          content,
          finishReason: extractOllamaFinishReason(response),
        },
        webToolPolicy,
      );
    }

    workingMessages = [...workingMessages, message];
    for (const toolCall of toolCalls) {
      const result = await executeOllamaToolCall(
        settings,
        toolCall,
        webToolPolicy,
      );
      workingMessages.push({
        role: "tool",
        name: toolCall.name,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error("Ollama tool-calling exceeded iteration limit");
}

export function buildOllamaThinkingMode(
  mode: Settings["chatThinkingMode"],
): boolean | "low" | "medium" | "high" | undefined {
  if (mode === "default") {
    return undefined;
  }
  if (mode === "off") {
    return false;
  }
  if (mode === "minimal") {
    return "low";
  }
  return mode;
}

export function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  const role = normalizeOllamaRole(message.role);
  const out: Record<string, unknown> = {
    role,
    content: message.content,
  };
  if (message.name && role === "tool") {
    out.name = message.name;
  }
  if (role === "user" && message.images && message.images.length > 0) {
    out.images = message.images.map((image) => image.data);
  }
  return out;
}

export function normalizeOllamaRole(role: ChatMessage["role"]): "system" | "user" | "assistant" | "tool" {
  if (role === "developer") {
    return "system";
  }
  if (role === "tool") {
    return "tool";
  }
  return role;
}

export function extractOllamaMessage(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  if (!message) {
    throw new ProviderApiError({
      kind: "empty_or_filtered",
      provider: "Ollama",
      status: 200,
      message: "Ollama API response missing message",
    });
  }
  return message;
}

export function normalizeOllamaContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const record = asRecord(item);
        const text = record?.text;
        return typeof text === "string" ? text : "";
      })
      .filter((item) => item.length > 0);
    return parts.join("\n").trim();
  }
  return "";
}

export function extractOllamaFinishReason(response: unknown): string | undefined {
  const record = asRecord(response);
  const finishReason =
    typeof record?.done_reason === "string"
      ? record.done_reason
      : typeof record?.doneReason === "string"
        ? record.doneReason
        : "";
  return finishReason || undefined;
}
