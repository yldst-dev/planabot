import { type Settings } from "../../config/settings.js";
import { type OllamaToolCall, type SearchToolName } from "../contracts.js";
import { WebToolPolicy } from "../webToolPolicy.js";
import { invokeOllamaApi } from "../ollama/api.js";
import { fetchWebPage } from "../webFetch.js";
import { asRecord } from "../value.js";

export function buildWebTools(
  enableWebSearch: boolean,
  enableWebFetch: boolean,
): Array<Record<string, unknown>> | undefined {
  const tools: Array<Record<string, unknown>> = [];
  if (enableWebSearch) {
    tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "최근 웹 정보를 검색하고 관련 결과 목록을 반환합니다.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "검색할 질의",
            },
            max_results: {
              type: "integer",
              description: "반환할 최대 검색 결과 수",
            },
          },
          required: ["query"],
        },
      },
    });
  }
  if (enableWebFetch) {
    tools.push({
      type: "function",
      function: {
        name: "web_fetch",
        description: "특정 웹페이지 본문을 가져옵니다.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "가져올 절대 URL",
            },
          },
          required: ["url"],
        },
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export async function executeOllamaToolCall(
  settings: Settings,
  toolCall: OllamaToolCall,
  policy: WebToolPolicy,
): Promise<unknown> {
  if (!policy.tryStartToolCall()) {
    return { error: "웹 도구 호출 한도를 초과했습니다." };
  }
  if (toolCall.name === "web_search") {
    if (settings.ollamaApiKeys.length === 0) {
      throw new Error("OLLAMA_API_KEY or OLLAMA_API_KEYS is required for Ollama web search");
    }
    const query = readRequiredString(toolCall.arguments.query, "web_search.query");
    const requestedMaxResults = readOptionalPositiveInt(toolCall.arguments.max_results);
    const maxResults = Math.min(
      settings.ollamaWebSearchMaxResults,
      requestedMaxResults ?? settings.ollamaWebSearchMaxResults,
    );
    const result = await invokeOllamaApi({
      providerName: "Ollama Web Search",
      host: settings.ollamaSearchHost,
      apiKeys: settings.ollamaApiKeys,
      path: "/api/web_search",
      payload: {
        query,
        max_results: maxResults,
      },
    });
    policy.addSearchResult(result);
    return result;
  }
  const url = readRequiredString(toolCall.arguments.url, "web_fetch.url");
  if (!policy.allowsFetch(url)) {
    return { error: "현재 요청이나 검색 결과에 없는 URL은 가져올 수 없습니다." };
  }
  try {
    return await fetchWebPage(settings, url);
  } catch {
    return { error: "웹페이지를 안전하게 가져오지 못했습니다." };
  }
}

export function extractOllamaToolCalls(message: Record<string, unknown>): OllamaToolCall[] {
  const rawToolCalls = message.tool_calls;
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }
  const toolCalls: OllamaToolCall[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const rawToolCall = asRecord(rawToolCalls[index]);
    const fn = asRecord(rawToolCall?.function);
    const name = normalizeToolName(fn?.name);
    if (!name) {
      continue;
    }
    const args = normalizeToolArguments(fn?.arguments);
    toolCalls.push({
      id: String(rawToolCall?.id ?? `${name}_${index}`),
      name,
      arguments: args,
    });
  }
  return toolCalls;
}

export function normalizeToolName(raw: unknown): SearchToolName | null {
  if (raw === "web_search" || raw === "web_fetch") {
    return raw;
  }
  return null;
}

export function normalizeToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

export function readRequiredString(value: unknown, key: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${key} is required`);
  }
  return normalized;
}

export function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}
