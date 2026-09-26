export const MEMORY_KINDS = ["profile", "request", "preference", "fact", "plan", "relationship", "room"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const PINNED_KINDS: readonly MemoryKind[] = ["profile", "request"];

export type ChatContext = {
  userId: string;
  chatId: string;
  direct: boolean;
};

export type MemoryRecord = {
  id: number;
  subjectUserId: string | null;
  chatId: string;
  direct: boolean;
  kind: MemoryKind;
  content: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt: number | null;
};

export type WireMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  at: number;
  ownerUserId?: string;
  wireMessages?: WireMessage[];
  epoch?: number;
};

export type MemoryOperation =
  | { op: "add"; kind: MemoryKind; content: string; importance: number; }
  | { op: "update"; id: number; content: string; importance?: number; }
  | { op: "delete"; id: number; };

export function isDirectChat(userId: string, chatId: string): boolean {
  return chatId === `chat_${userId}`;
}

export function chatContext(userId: string, chatId: string): ChatContext {
  return { userId, chatId, direct: isDirectChat(userId, chatId) };
}
