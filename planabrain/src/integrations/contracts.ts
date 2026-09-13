import { type Settings } from "../config/settings.js";

export type GeminiSafetySetting = {
  category: string;
  threshold: string;
};

export type InputImage = {
  data: string;
  mimeType: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string;
  name?: string;
  contextKind?: "history" | "memory" | "reference" | "evidence" | "current";
  images?: InputImage[];
};

export type SearchToolName = "web_search" | "web_fetch";

export type OllamaToolCall = {
  id: string;
  name: SearchToolName;
  arguments: Record<string, unknown>;
};

export type WebCitation = {
  url: string;
  title?: string;
  evidence?: string;
};

export type WireMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatInvocationMetadata = {
  content: string;
  citations: WebCitation[];
  searchUsed: boolean;
  finishReason?: string;
  wireMessages: WireMessage[];
};

export type ChatInvocationResult = {
  content: string;
  finishReason?: string;
  citations?: WebCitation[];
  searchUsed?: boolean;
};

export type ChatInvocationParams = {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
  webFetchUrlSource?: string;
  preSearchQuery?: string;
  maxContinuations?: number;
  preserveReplay?: boolean;
};

export type PreSearchContext = {
  context: string;
  citations: WebCitation[];
};

export type ChatProviderName = Settings["aiProvider"];

export type ChatInvocationOnceParams = {
  settings: Settings;
  messages: ChatMessage[];
  enableSearchTool?: boolean;
  webFetchUrlSource?: string;
};

export type ChatProvider = {
  supportsImages: boolean;
  hasCredentials: (settings: Settings) => boolean;
  searchAvailable: (settings: Settings) => boolean;
  invoke: (params: ChatInvocationOnceParams) => Promise<ChatInvocationResult>;
};

export type OpenAICompatibleToolChatConfig = {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  webSearchAvailable: boolean;
  webFetchAvailable: boolean;
};
