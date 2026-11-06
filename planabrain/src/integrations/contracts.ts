import { type Settings } from "../config/settings.js";

export type InputImage = {
  data: string;
  mimeType: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolMode = "auto" | "none";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer";
  content: string;
  contextKind?: "history" | "memory" | "reference" | "evidence" | "current";
  images?: InputImage[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  providerContent?: unknown[];
};

export type WebCitation = {
  url: string;
  title?: string;
  evidence?: string;
};

export type WireMessage = {
  role: "user" | "assistant";
  content: string;
  readLinks?: string[];
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
  toolCalls?: ToolCall[];
  providerContent?: unknown[];
};

export type WebFetchRound = {
  outputs: Array<{ callId: string; output: string; }>;
  images: InputImage[];
  discard?: () => void;
};

export type WebFetchRunner = (calls: ToolCall[]) => Promise<WebFetchRound>;

export type ChatInvocationParams = {
  settings: Settings;
  messages: ChatMessage[];
  preSearchQuery?: string;
  maxContinuations?: number;
  webFetch?: WebFetchRunner;
};

export const WEB_FETCH_TOOL = {
  name: "web_fetch",
  description: [
    "대화에 나온 링크의 웹페이지 본문을 읽습니다.",
    "현재 질문에 답하려면 그 페이지의 내용을 알아야 할 때만 호출합니다.",
    "정리나 요약을 직접 부탁하지 않아도, '이거 진짜야?', '이게 무슨 소리야', '어떻게 생각해?'처럼 질문이 링크의 글을 가리키면 호출합니다.",
    "일반 상식, 계산, 잡담, 인사, 프라나 자신에 관한 질문처럼 페이지와 무관한 질문에는 답장한 글에 링크가 있어도 호출하지 않습니다.",
    "주소 문자열만 보고 답할 수 있는 질문, 방금 답변을 줄이거나 다시 묻는 것처럼 대화 내용만으로 답할 수 있는 질문에도 호출하지 않습니다.",
    "READABLE_LINKS에 있는 주소만 읽을 수 있습니다.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "READABLE_LINKS에 있는 전체 주소" } },
    required: ["url"],
    additionalProperties: false,
  },
} as const;

export type PreSearchContext = {
  context: string;
  citations: WebCitation[];
};
