import { checkExecution, runExecution } from "../runtime/execution.js";
import { buildMemoryContext, listRecentTurns, recallMemories } from "../memory/service.js";
import type { MemoryRecall } from "../memory/recall.js";
import { interpretScheduleRequest } from "../schedule/intent.js";
import { interpretTodoRequest, type TodoAction } from "../todo/intent.js";
import { classifyTurn, type TurnClassification, type TurnClassificationInput, type TurnSignals } from "../decision/turnSignals.js";
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
  signals: TurnSignals | null;
  memoryContext: string | null;
  recentTurns: RecentTurn[];
  errors: Record<string, string>;
};

export type TurnPrepareDeps = {
  classifyTurn: (input: TurnClassificationInput) => Promise<TurnClassification | undefined>;
  interpretTodo: (userId: string, text: string, action?: TodoAction) => Promise<{ handled: boolean; }>;
  interpretSchedule: (text: string) => { handled: boolean; };
  listTodos: (userId: string) => Promise<unknown>;
  recallMemory: (input: { userId: string; chatScope: string; query: string; }) => Promise<MemoryRecall>;
  renderMemory: (input: {
    recall: MemoryRecall;
    relevantIds?: ReadonlySet<number>;
    query: string;
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
    signals: null,
    memoryContext: null,
    recentTurns: [],
    errors: {},
  };

  const memoryEnabled = input.memoryEnabled !== false;
  const query = input.memoryQueryText ?? input.question;
  let recentTurns: RecentTurn[] = [];
  if (memoryEnabled && input.conversationId) {
    try {
      recentTurns = await deps.listRecentTurns({
        chatScope: input.chatScope,
        conversationId: input.conversationId,
      });
    } catch (error) {
      output.errors.recentTurns = describeError(error);
    }
  }

  let recall: MemoryRecall = { pinned: [], candidates: [] };
  if (memoryEnabled) {
    try {
      recall = await deps.recallMemory({ userId: input.userId, chatScope: input.chatScope, query });
    } catch (error) {
      output.errors.memory = describeError(error);
    }
  }

  let classification: TurnClassification | undefined;
  try {
    classification = await deps.classifyTurn({
      message: query,
      previousUserMessage: recentTurns.filter((turn) => turn.role === "user").at(-1)?.text,
      memories: recall.candidates.map((memory) => ({ id: memory.id, content: memory.content })),
    });
  } catch (error) {
    output.errors.signals = describeError(error);
  }
  output.signals = classification?.signals ?? null;
  const route = output.signals?.routeConfident ? output.signals.route : undefined;

  if (!route || route.startsWith("todo_")) {
    try {
      output.todo = await deps.interpretTodo(input.userId, input.question, route ? toTodoAction(route) : undefined);
    } catch (error) {
      output.errors.todo = describeError(error);
    }
    if (output.todo?.handled) {
      return output;
    }
  }

  if (!route || route.startsWith("schedule_")) {
    try {
      output.schedule = deps.interpretSchedule(input.question);
    } catch (error) {
      output.errors.schedule = describeError(error);
    }
    if (output.schedule?.handled) {
      return output;
    }
  }

  try {
    output.todoList = await deps.listTodos(input.userId);
  } catch (error) {
    output.errors.todoList = describeError(error);
  }

  if (memoryEnabled) {
    try {
      output.memoryContext = await deps.renderMemory({
        recall,
        relevantIds: classification?.relevantMemoryIds,
        query,
        tokenBudget: input.tokenBudget,
      });
    } catch (error) {
      output.errors.memory = describeError(error);
    }
    output.recentTurns = recentTurns;
  }

  return output;
}

function toTodoAction(route: TurnSignals["route"]): TodoAction | undefined {
  const action = route.slice("todo_".length);
  return ["add", "complete", "delete", "update", "list"].includes(action) ? (action as TodoAction) : undefined;
}

export function buildTurnPrepareDeps(nowMs?: number): TurnPrepareDeps {
  return {
    classifyTurn: (input) => classifyTurn(input),
    interpretTodo: (userId, text, action) => interpretTodoRequest(userId, text, action),
    interpretSchedule: (text) => interpretScheduleRequest(text, { nowMs }),
    listTodos: (userId) => listTodos(userId),
    recallMemory: async (params) => recallMemories({ userId: params.userId, chatId: params.chatScope, query: params.query }),
    renderMemory: async (params) => buildMemoryContext(params),
    listRecentTurns: async (params) => listRecentTurns(params.chatScope, params.conversationId),
  };
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
