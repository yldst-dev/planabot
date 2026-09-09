import { type WireMessage, type InputImage, type PreSearchContext, type ChatMessage } from "../integrations/chat.js";
import { type Settings } from "../config/settings.js";

export type RecentTurnInput = {
  role: "user" | "assistant";
  text: string;
  at?: number;
  wireMessages?: WireMessage[];
  epoch?: number;
};

export type TurnTranscript = {
  wireMessages: WireMessage[];
  epoch: number;
};

export type TurnAnswer = {
  answer: string;
  transcript?: TurnTranscript;
};

export type AnswerTurnParams = {
  question: string;
  currentTurnText?: string;
  settings: Settings;
  userId?: string;
  chatScope?: string;
  conversationId?: string;
  images?: InputImage[];
  linkSourceText?: string;
  memoryContext?: string;
  recentTurns?: RecentTurnInput[];
  continuousChat?: boolean;
  workingTurnLimit?: number;
};

export type PreparedSearch = {
  query: string | undefined;
  context: PreSearchContext | null;
};

export type Replay = {
  messages: ChatMessage[];
  epoch: number;
  turnCount: number;
};
