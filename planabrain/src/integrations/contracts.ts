import { type Settings } from "../config/settings.js";

export type InputImage = {
  data: string;
  mimeType: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer";
  content: string;
  contextKind?: "history" | "memory" | "reference" | "evidence" | "current";
  images?: InputImage[];
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
  preSearchQuery?: string;
  maxContinuations?: number;
};

export type PreSearchContext = {
  context: string;
  citations: WebCitation[];
};
