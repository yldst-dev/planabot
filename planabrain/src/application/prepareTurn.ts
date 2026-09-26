import { checkExecution, runExecution } from "../runtime/execution.js";
import { LocalMemoryEngine } from "../memoryflow/memory-engine.js";
import { interpretScheduleRequest } from "../schedule/intent.js";
import { interpretTodoRequest } from "../todo/intent.js";
import { listTodos } from "../todo/store.js";

export type TurnPrepareInput = {
  requestId?: string;
  deadlineMs?: number;
  userId: string;
  chatScope: string;
  conversationId?: string;
  question: string;
  memoryQueryText?: string;
  nowMs?: number;
  memoryEnabled?: boolean;
  tokenBudget?: number;
};

export type RecentTurn = {
  role: "user" | "assistant";
  text: string;
  at: number;
  ownerUserId?: string;
  wireMessages?: Array<{ role: "user" | "assistant"; content: string; }>;
  epoch?: number;
};

export type TurnPrepareOutput = {
  todo: { handled: boolean; } | null;
  schedule: { handled: boolean; } | null;
  todoList: unknown | null;
  memoryContext: string | null;
  recentTurns: RecentTurn[];
  errors: Record<string, string>;
};

export type TurnPrepareDeps = {
  interpretTodo: (userId: string, text: string) => Promise<{ handled: boolean; }>;
  interpretSchedule: (text: string) => { handled: boolean; };
  listTodos: (userId: string) => Promise<unknown>;
  prepareMemory: (input: {
    userId: string;
    chatScope: string;
    conversationId?: string;
    userText: string;
    tokenBudget?: number;
  }) => Promise<string | null>;
  listRecentTurns: (input: { chatScope: string; conversationId: string; }) => Promise<RecentTurn[]>;
};

export async function prepareTurn(
  input: TurnPrepareInput,
  deps: TurnPrepareDeps = buildTurnPrepareDeps(input.nowMs),
): Promise<TurnPrepareOutput> {
  return runExecution("turn-prepare", () => executePrepareTurn(input, deps), {
    requestId: input.requestId,
    deadlineMs: input.deadlineMs,
  });
}

async function executePrepareTurn(input: TurnPrepareInput, deps: TurnPrepareDeps): Promise<TurnPrepareOutput> {
  const output: TurnPrepareOutput = {
    todo: null,
    schedule: null,
    todoList: null,
    memoryContext: null,
    recentTurns: [],
    errors: {},
  };

  try {
    output.todo = await deps.interpretTodo(input.userId, input.question);
  } catch (error) {
    output.errors.todo = describeError(error);
  }
  if (output.todo?.handled) {
    return output;
  }

  try {
    output.schedule = deps.interpretSchedule(input.question);
  } catch (error) {
    output.errors.schedule = describeError(error);
  }
  if (output.schedule?.handled) {
    return output;
  }

  try {
    output.todoList = await deps.listTodos(input.userId);
  } catch (error) {
    output.errors.todoList = describeError(error);
  }

  if (input.memoryEnabled !== false) {
    try {
      output.memoryContext = await deps.prepareMemory({
        userId: input.userId,
        chatScope: input.chatScope,
        conversationId: input.conversationId,
        userText: input.memoryQueryText ?? input.question,
        tokenBudget: input.tokenBudget,
      });
    } catch (error) {
      output.errors.memory = describeError(error);
    }
    if (input.conversationId) {
      try {
        output.recentTurns = await deps.listRecentTurns({
          chatScope: input.chatScope,
          conversationId: input.conversationId,
        });
      } catch (error) {
        output.errors.recentTurns = describeError(error);
      }
    }
  }

  return output;
}

export function buildTurnPrepareDeps(nowMs?: number): TurnPrepareDeps {
  return {
    interpretTodo: (userId, text) => interpretTodoRequest(userId, text),
    interpretSchedule: (text) => interpretScheduleRequest(text, { nowMs }),
    listTodos: (userId) => listTodos(userId),
    prepareMemory: async (params) => {
      const engine = new LocalMemoryEngine();
      try {
        const prepared = await engine.preparePromptInput({
          userId: params.userId,
          chatId: params.chatScope,
          conversationId: params.conversationId,
          userText: params.userText,
          tokenBudget: params.tokenBudget,
        });
        return normalizeMemoryContext(prepared.memoryContext);
      } finally {
        engine.close();
      }
    },
    listRecentTurns: async (params) => {
      const engine = new LocalMemoryEngine();
      try {
        const turns = await engine.listConversationTurns({
          chatId: params.chatScope,
          conversationId: params.conversationId,
        });
        return turns.map((turn) => ({
          role: turn.role,
          text: turn.text,
          at: turn.at,
          ...(turn.ownerUserId ? { ownerUserId: turn.ownerUserId } : {}),
          ...(turn.wireMessages ? { wireMessages: turn.wireMessages } : {}),
          ...(typeof turn.epoch === "number" ? { epoch: turn.epoch } : {}),
        }));
      } finally {
        engine.close();
      }
    },
  };
}

export function normalizeMemoryContext(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.toLowerCase() === "memory_context: none") {
    return null;
  }
  return text;
}

function describeError(error: unknown): string {
  checkExecution();
  return error instanceof Error ? error.message : String(error);
}

export function parseTurnPrepareInput(raw: string): TurnPrepareInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("turn-prepare 입력은 JSON이어야 합니다");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("turn-prepare 입력은 JSON 객체여야 합니다");
  }
  const record = parsed as Record<string, unknown>;
  const userId = readRequiredString(record.userId, "userId");
  const chatScope = readRequiredString(record.chatScope, "chatScope");
  const question = readRequiredString(record.question, "question");
  const requestId = readOptionalString(record.requestId);
  if (requestId && !/^[a-zA-Z0-9_-]{1,128}$/u.test(requestId)) {
    throw new Error("요청 ID 형식이 올바르지 않습니다.");
  }
  return {
    requestId,
    deadlineMs: typeof record.deadlineMs === "number" && Number.isFinite(record.deadlineMs) ? record.deadlineMs : undefined,
    userId,
    chatScope,
    question,
    conversationId: readOptionalString(record.conversationId),
    memoryQueryText: readOptionalString(record.memoryQueryText),
    nowMs: readOptionalNumber(record.nowMs),
    memoryEnabled: typeof record.memoryEnabled === "boolean" ? record.memoryEnabled : undefined,
    tokenBudget: readOptionalNumber(record.tokenBudget),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`turn-prepare 입력에 ${field}가 필요합니다`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
