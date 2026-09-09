import { createHash } from "node:crypto";
import path from "node:path";
import { LocalMemoryEngine } from "../memoryflow/memory-engine.js";

export type StoredChatMessage = {
  role: "human" | "ai";
  content: string;
  at: number;
};

type MemoryParams = {
  memoryDir: string;
  userId: string;
  chatScope?: string;
  conversationId?: string;
  maxMessages: number;
};

function createEngine(params: MemoryParams): LocalMemoryEngine {
  return new LocalMemoryEngine({
    rootDir: path.join(params.memoryDir, "scoped"),
    sqlitePath: path.join(params.memoryDir, "scoped.sqlite"),
    groupMemoryEnabled: false,
    compactionEnabled: false,
    maxWorkingTurns: Math.max(2, params.maxMessages),
  });
}

function scope(params: MemoryParams): { chatId: string; conversationId: string; } {
  return {
    chatId: params.chatScope ?? "cli",
    conversationId: createHash("sha256").update(JSON.stringify([params.userId, params.conversationId ?? "default"])).digest("hex"),
  };
}

export async function loadUserMemory(params: MemoryParams): Promise<StoredChatMessage[]> {
  if (params.maxMessages <= 0) return [];
  const engine = createEngine(params);
  try {
    const turns = await engine.listConversationTurns(scope(params));
    return turns.slice(-params.maxMessages).map((turn) => ({
      role: turn.role === "assistant" ? "ai" : "human",
      content: turn.text,
      at: turn.at,
    }));
  } finally {
    engine.close();
  }
}

export async function appendUserMemory(params: MemoryParams & { messages: StoredChatMessage[]; }): Promise<void> {
  if (params.maxMessages <= 0) return;
  const engine = createEngine(params);
  try {
    for (let index = 0; index + 1 < params.messages.length; index += 2) {
      const user = params.messages[index];
      const assistant = params.messages[index + 1];
      if (user.role !== "human" || assistant.role !== "ai") continue;
      await engine.rememberExchange({
        ...scope(params),
        userId: params.userId,
        userText: user.content,
        assistantText: assistant.content,
        at: user.at,
      });
    }
  } finally {
    engine.close();
  }
}

export async function resetScopedUserMemory(userId: string, memoryDir: string): Promise<boolean> {
  const engine = createEngine({ userId, memoryDir, maxMessages: 0 });
  try { return (await engine.resetUser(userId)).removed; } finally { engine.close(); }
}
