import { LocalMemoryEngine } from "../../memoryflow/memory-engine.js";
import { interpretScheduleRequest } from "../../schedule/intent.js";
import { interpretTodoRequest } from "../../todo/intent.js";
import { listTodos } from "../../todo/store.js";

export type TurnPrepareInput = {
  userId: string;
  chatScope: string;
  conversationId?: string;
  question: string;
  memoryQueryText?: string;
  nowMs?: number;
  memoryEnabled?: boolean;
  tokenBudget?: number;
};

export type TurnPrepareOutput = {
  todo: { handled: boolean } | null;
  schedule: { handled: boolean } | null;
  todoList: unknown | null;
  memoryContext: string | null;
  errors: Record<string, string>;
};

export type TurnPrepareDeps = {
  interpretTodo: (userId: string, text: string) => Promise<{ handled: boolean }>;
  interpretSchedule: (text: string) => { handled: boolean };
  listTodos: (userId: string) => Promise<unknown>;
  prepareMemory: (input: {
    userId: string;
    chatScope: string;
    conversationId?: string;
    userText: string;
    tokenBudget?: number;
  }) => Promise<string | null>;
};

export async function prepareTurn(
  input: TurnPrepareInput,
  deps: TurnPrepareDeps,
): Promise<TurnPrepareOutput> {
  const output: TurnPrepareOutput = {
    todo: null,
    schedule: null,
    todoList: null,
    memoryContext: null,
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
  }

  return output;
}

export function parseTurnPrepareInput(raw: string): TurnPrepareInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("turn-prepare 입력은 JSON이어야 합니다");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("turn-prepare 입력은 JSON 객체여야 합니다");
  }
  const record = parsed as Record<string, unknown>;
  const userId = readRequiredString(record.userId, "userId");
  const chatScope = readRequiredString(record.chatScope, "chatScope");
  const question = readRequiredString(record.question, "question");
  return {
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

export async function runTurnPrepareCommand(): Promise<void> {
  const input = parseTurnPrepareInput(await readStdin());
  if (input.nowMs) {
    process.env.PLANABRAIN_NOW_MS = String(input.nowMs);
  }
  const output = await prepareTurn(input, {
    interpretTodo: (userId, text) => interpretTodoRequest(userId, text),
    interpretSchedule: (text) => interpretScheduleRequest(text),
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
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

export function normalizeMemoryContext(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.toLowerCase() === "memory_context: none") {
    return null;
  }
  return text;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
