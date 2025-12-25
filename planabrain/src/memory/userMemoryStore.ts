import { promises as fs } from "node:fs";
import path from "node:path";

export type StoredChatMessage = {
  role: "human" | "ai";
  content: string;
  at: number;
};

type StoredChatFile = {
  version: 1;
  messages: StoredChatMessage[];
};

function safeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) return "default";
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200) || "default";
}

function userMemoryFilePath(memoryDir: string, userId: string): string {
  return path.join(memoryDir, `${safeUserId(userId)}.json`);
}

export async function loadUserMemory(params: {
  memoryDir: string;
  userId: string;
  maxMessages: number;
}): Promise<StoredChatMessage[]> {
  const filePath = userMemoryFilePath(params.memoryDir, params.userId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<StoredChatFile>;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  const normalized: StoredChatMessage[] = messages
    .filter((m) => Boolean(m) && typeof (m as { content?: unknown }).content === "string")
    .map((m) => {
      const roleRaw = (m as { role?: unknown }).role;
      const role: StoredChatMessage["role"] = roleRaw === "ai" ? "ai" : "human";
      const content = String((m as { content?: unknown }).content ?? "");
      const atRaw = (m as { at?: unknown }).at;
      const at = typeof atRaw === "number" ? atRaw : Date.now();
      return { role, content, at };
    })
    .filter((m) => m.content.trim().length > 0);

  if (params.maxMessages <= 0) return [];
  return normalized.slice(-params.maxMessages);
}

export async function appendUserMemory(params: {
  memoryDir: string;
  userId: string;
  maxMessages: number;
  messages: StoredChatMessage[];
}): Promise<void> {
  const existing = await loadUserMemory({
    memoryDir: params.memoryDir,
    userId: params.userId,
    maxMessages: Math.max(0, params.maxMessages)
  });

  const combined = [...existing, ...params.messages].filter(
    (m) => m.content.trim().length > 0
  );

  const kept =
    params.maxMessages <= 0 ? [] : combined.slice(-Math.max(0, params.maxMessages));

  const file: StoredChatFile = { version: 1, messages: kept };
  await fs.mkdir(params.memoryDir, { recursive: true });
  const filePath = userMemoryFilePath(params.memoryDir, params.userId);
  await fs.writeFile(filePath, JSON.stringify(file), "utf-8");
}
