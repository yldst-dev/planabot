import { resolveAuxSettings } from "../chat/auxSettings.js";
import { loadSettings, type Settings } from "../config/settings.js";
import { loadDecisionEvaluator } from "../decision/config.js";
import { invokeChat } from "../integrations/chat.js";
import { runDetached, runExecution } from "../runtime/execution.js";
import { serial } from "../runtime/serial.js";
import { loadMemoryConfig, type MemoryConfig } from "./config.js";
import { MemoryDatabase } from "./database.js";
import { fallbackRelevant, renderMemoryContext, selectRecall, type MemoryRecall } from "./recall.js";
import { chatContext, type ConversationTurn, type MemoryRecord, type WireMessage } from "./types.js";
import { planMemoryOperations } from "./writer.js";

export type ExchangeInput = {
  userId: string;
  requestId?: string;
  chatId: string;
  conversationId?: string;
  userText: string;
  assistantText: string;
  wireMessages?: WireMessage[];
  epoch?: number;
};

export type ExchangeResult = {
  recorded: boolean;
  writer: "queued" | "done" | "skipped";
};

const databases = new Map<string, MemoryDatabase>();

export function openMemoryDatabase(config: MemoryConfig = loadMemoryConfig()): MemoryDatabase {
  let database = databases.get(config.databasePath);
  if (!database) {
    database = new MemoryDatabase(config.databasePath);
    databases.set(config.databasePath, database);
  }
  return database;
}

export function closeMemoryDatabases(): void {
  for (const database of databases.values()) database.close();
  databases.clear();
}

export function recallMemories(params: { userId: string; chatId: string; query: string; }): MemoryRecall {
  const memories = openMemoryDatabase().listVisibleMemories(chatContext(params.userId, params.chatId));
  return selectRecall(memories, params.query);
}

export function buildMemoryContext(params: {
  recall: MemoryRecall;
  relevantIds?: ReadonlySet<number>;
  query: string;
  tokenBudget?: number;
}): string | null {
  const relevant = params.relevantIds
    ? params.recall.candidates.filter((memory) => params.relevantIds?.has(memory.id))
    : fallbackRelevant(params.recall.candidates, params.query);
  const selected = [...params.recall.pinned, ...relevant];
  if (selected.length === 0) return null;
  openMemoryDatabase().markRecalled(selected.map((memory) => memory.id), Date.now());
  return renderMemoryContext(selected, params.tokenBudget ?? 900);
}

export function listRecentTurns(chatId: string, conversationId: string): ConversationTurn[] {
  const config = loadMemoryConfig();
  return openMemoryDatabase(config).listConversationTurns(chatId, conversationId, Date.now() - config.conversationTtlMs);
}

export function listMemories(userId: string, chatId: string): MemoryRecord[] {
  return openMemoryDatabase().listVisibleMemories(chatContext(userId, chatId));
}

export function forgetMemory(userId: string, chatId: string, id: number): boolean {
  return openMemoryDatabase().forget(chatContext(userId, chatId), id);
}

export function resetUserMemory(userId: string): boolean {
  return openMemoryDatabase().resetUser(userId);
}

export function resetAllMemory(): boolean {
  return openMemoryDatabase().resetAll();
}

export async function rememberExchange(
  input: ExchangeInput,
  options: { settings?: Settings; background: boolean; },
): Promise<ExchangeResult> {
  const userText = input.userText.trim();
  const assistantText = input.assistantText.trim();
  if (!userText || !assistantText) {
    throw new Error("사용자 질문과 응답이 모두 필요합니다.");
  }
  const config = loadMemoryConfig();
  const startedAt = Date.now();
  const recorded = openMemoryDatabase(config).recordExchange({
    requestId: input.requestId,
    chatId: input.chatId,
    conversationId: input.conversationId,
    maxTurns: config.maxConversationTurns,
    cutoffAt: startedAt - config.conversationTtlMs,
    turns: [
      { role: "user", text: userText, at: startedAt, ownerUserId: input.userId, ...(input.epoch === undefined ? {} : { epoch: input.epoch }) },
      {
        role: "assistant",
        text: sanitizeAssistantTurn(userText, assistantText),
        at: startedAt + 1,
        ...(input.wireMessages?.length ? { wireMessages: input.wireMessages } : {}),
        ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
      },
    ],
  });
  if (!recorded || !config.writerEnabled) {
    return { recorded, writer: "skipped" };
  }
  const job = (): Promise<void> => runExecution("memory-write", () =>
    serial(`memory-writer:${input.userId}`, () => writeLongTermMemory(input.userId, input.chatId, userText, assistantText, startedAt, config, options.settings)),
  );
  if (!options.background) {
    await job();
    return { recorded, writer: "done" };
  }
  void runDetached(job).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 기억 작성 실패: ${reason}`);
  });
  return { recorded, writer: "queued" };
}

async function writeLongTermMemory(
  userId: string,
  chatId: string,
  userText: string,
  assistantText: string,
  startedAt: number,
  config: MemoryConfig,
  settings: Settings | undefined,
): Promise<void> {
  const database = openMemoryDatabase(config);
  const context = chatContext(userId, chatId);
  const baseSettings = settings ?? loadSettings();
  const auxSettings = resolveAuxSettings(baseSettings);
  const decision = loadDecisionEvaluator(process.env, () => baseSettings);
  const operations = await planMemoryOperations(
    { context, userText, assistantText, existing: database.listVisibleMemories(context) },
    {
      decision: decision?.name === "jev" ? decision : undefined,
      complete: (system, user) => invokeChat({
        settings: auxSettings,
        maxContinuations: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
  );
  if (operations.length === 0) return;
  const applied = database.applyOperations({
    context,
    operations,
    startedAt,
    maxMemoriesPerUser: config.maxMemoriesPerUser,
  });
  console.error(`[planabrain] 기억 갱신 ${applied}건 (${operations.map((operation) => operation.op).join(",")})`);
}

const TIME_SENSITIVE_PATTERN =
  /(날씨|기온|강수|습도|미세먼지|대기질|환율|시세|주가|코인|암호화폐|금리|뉴스|속보|물가|가격|재고|운행|항공편|교통|경기\s*(?:결과|일정)|스코어|순위|통계|선거\s*결과)/u;

function sanitizeAssistantTurn(userText: string, assistantText: string): string {
  if (TIME_SENSITIVE_PATTERN.test(userText)) {
    return "시의성 정보 확인 응답 완료.";
  }
  const sanitized = assistantText
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("출처:"))
    .join("\n")
    .trim();
  return sanitized || "응답 완료.";
}
