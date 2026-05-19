import {
  addTodo,
  completeTodo,
  deleteTodo,
  listTodos,
  updateTodo,
  type TodoItem
} from "./store.js";

export type TodoInterpretOutput = {
  handled: boolean;
  action: "none" | "list" | "add" | "complete" | "update" | "delete";
  message: string;
  items: TodoItem[];
  error?: string;
};

export async function interpretTodoRequest(userId: string, text: string): Promise<TodoInterpretOutput> {
  const userText = extractUserText(text);
  const normalized = normalizeIntentText(userText);
  const todoRelated = isTodoRelated(normalized) || isTodoContextText(text);

  const update = parseUpdate(userText);
  if (update) {
    const result = await updateTodo(userId, update.target, update.content);
    if (!result.ok && !todoRelated) {
      return emptyOutput();
    }
    return mutationOutput("update", result.ok ? "수정 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (hasAny(normalized, ["삭제", "지워", "제거"])) {
    const target = extractTarget(userText, ["삭제", "지워", "제거", "해줘", "해주세요", "해", "줘"]);
    const result = await deleteTodo(userId, target);
    if (!result.ok && !todoRelated) {
      return emptyOutput();
    }
    return mutationOutput("delete", result.ok ? "삭제 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (hasAny(normalized, ["완료", "끝냈", "끝낫", "처리했", "체크", "했어", "했습니다"])) {
    const target = extractCompleteTarget(userText, text, todoRelated);
    const result = await completeTodo(userId, target);
    if (!result.ok && !todoRelated) {
      return emptyOutput();
    }
    return mutationOutput("complete", result.ok ? "완료 처리했습니다.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (!todoRelated) {
    return emptyOutput();
  }

  const add = parseAdd(userText, todoRelated);
  if (add) {
    const result = await addTodo(userId, add);
    return mutationOutput("add", result.ok ? "등록 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (isListRequest(normalized)) {
    const result = await listTodos(userId);
    return {
      handled: true,
      action: "list",
      message: result.markdown,
      items: result.items
    };
  }

  return emptyOutput();
}

function mutationOutput(
  action: TodoInterpretOutput["action"],
  prefix: string,
  result: {
    ok: boolean;
    items: TodoItem[];
    markdown: string;
    error?: string;
  }
): TodoInterpretOutput {
  const message = result.ok
    ? `${prefix}\n\n${result.markdown}`
    : `${prefix}\n${result.error ?? "작업을 처리하지 못했습니다."}\n\n${result.markdown}`;
  return {
    handled: true,
    action,
    message,
    items: result.items,
    ...(result.error ? { error: result.error } : {})
  };
}

function parseAdd(text: string, allowImplicit: boolean): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /(?:할\s*일|todo|투두)(?:에|로)?\s+(.+?)(?:을|를)?\s*(?:추가|등록)/i,
    /(?:추가|등록)(?:해줘|해주세요|해|합니다|해라)?[:\s]+(.+)/i,
    /(.+?)(?:을|를)?\s*(?:할\s*일|todo|투두)(?:에|로)?\s*(?:추가|등록)/i
  ];
  if (allowImplicit) {
    patterns.push(/(.+?)(?:을|를)?\s*(?:추가|등록)(?:해줘|해주세요|해|합니다|해라)?$/i);
  }
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const content = cleanupTarget(match?.[1] ?? "");
    if (content) {
      return content;
    }
  }
  return undefined;
}

function parseUpdate(text: string): { target: string; content: string } | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /(.+?)(?:을|를)?\s+(.+?)(?:으로|로)\s*(?:수정|변경|바꿔|바꿔줘|고쳐)/,
    /(.+?)(?:을|를)?\s*(?:수정|변경|바꿔|고쳐).+?(?:으로|로)\s+(.+)/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const target = cleanupTarget(match?.[1] ?? "");
    const content = cleanupTarget(match?.[2] ?? "");
    if (target && content) {
      return { target, content };
    }
  }
  return undefined;
}

function extractTarget(text: string, words: string[]): string {
  let value = extractUserText(text);
  for (const word of words) {
    value = value.replaceAll(word, " ");
  }
  value = value.replace(/(?:할\s*일|todo|투두|항목|체크박스)/gi, " ");
  return cleanupTarget(value);
}

function extractCompleteTarget(userText: string, fullText: string, todoRelated: boolean): string {
  const target = extractTarget(userText, [
    "완료",
    "완료했어",
    "완료했습니다",
    "끝냈어",
    "끝냈습니다",
    "처리했어",
    "처리했습니다",
    "체크",
    "했어",
    "했습니다",
    "해줘",
    "해주세요",
    "해",
    "줘"
  ]);
  const selectedTarget = extractSelectedOpenTodoFromContext(target, fullText);
  if (selectedTarget) {
    return selectedTarget;
  }
  if (target || !todoRelated) {
    return target;
  }
  return extractSingleOpenTodoFromContext(fullText) ?? "";
}

function extractSingleOpenTodoFromContext(text: string): string | undefined {
  const openItems = extractOpenTodosFromContext(text);
  const uniqueItems = [...new Set(openItems)];
  return uniqueItems.length === 1 ? uniqueItems[0] : undefined;
}

function extractSelectedOpenTodoFromContext(target: string, text: string): string | undefined {
  const openItems = extractOpenTodosFromContext(text);
  const index = parseTodoSelectorIndex(target, openItems.length);
  return index === undefined ? undefined : openItems[index];
}

function extractOpenTodosFromContext(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*\[\s\]\s+(.+)$/)?.[1] ?? "")
    .map((item) => cleanupTarget(item))
    .filter((item) => item && item !== "등록된 항목이 없습니다.");
}

function parseTodoSelectorIndex(target: string, itemCount: number): number | undefined {
  if (itemCount <= 0) {
    return undefined;
  }
  const value = normalizeSelectorText(target);
  if (!value) {
    return undefined;
  }
  if (/^(마지막|마지막거|마지막것|마지막꺼|마지막항목|맨마지막|맨마지막거)$/.test(value)) {
    return itemCount - 1;
  }
  const numeric = value.match(/^(\d+)(?:번|번째|째)?(?:거|것|꺼|항목)?$/);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return index >= 0 && index < itemCount ? index : undefined;
  }
  const ordinals = [
    ["첫", "첫번", "첫번째", "첫째", "처음", "맨위", "맨첫", "일번", "일번째"],
    ["두", "두번", "두번째", "둘째", "이번", "이번째"],
    ["세", "세번", "세번째", "셋째", "삼번", "삼번째"],
    ["네", "네번", "네번째", "넷째", "사번", "사번째"],
    ["다섯", "다섯번", "다섯번째", "오번", "오번째"],
    ["여섯", "여섯번", "여섯번째", "육번", "육번째"],
    ["일곱", "일곱번", "일곱번째", "칠번", "칠번째"],
    ["여덟", "여덟번", "여덟번째", "팔번", "팔번째"],
    ["아홉", "아홉번", "아홉번째", "구번", "구번째"],
    ["열", "열번", "열번째", "십번", "십번째"]
  ];
  const index = ordinals.findIndex((words) =>
    words.some((word) => value === word || value === `${word}거` || value === `${word}것` || value === `${word}꺼` || value === `${word}항목`)
  );
  return index >= 0 && index < itemCount ? index : undefined;
}

function normalizeSelectorText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s:：,.\-()[\]{}"'`!?。！？]/g, "")
    .trim();
}

function cleanupTarget(text: string): string {
  return stripTodoCommandTail(text)
    .replace(/^[\s:：,.\-]+/, "")
    .replace(/(?:을|를|은|는|이|가|도|좀|제발|부탁)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTodoCommandTail(text: string): string {
  let value = text.replace(/\s+/g, " ").trim();
  const patterns = [
    /\s+(?:오늘|내일|금일|today)\s*(?:todo|투두|할\s*일|체크리스트)?$/i,
    /\s+(?:todo|투두|할\s*일|체크리스트)\s*(?:오늘|내일|금일|today)?$/i
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = value.replace(pattern, "").trim();
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

function extractUserText(text: string): string {
  const marker = "사용자 질문:";
  const idx = text.lastIndexOf(marker);
  const value = idx >= 0 ? text.slice(idx + marker.length) : text;
  const questionMarker = "질문:";
  const questionIdx = value.lastIndexOf(questionMarker);
  return (questionIdx >= 0 ? value.slice(questionIdx + questionMarker.length) : value).trim();
}

function isTodoRelated(text: string): boolean {
  return hasAny(text, ["할 일", "해야 할 일", "todo", "투두", "체크리스트"]);
}

function isTodoContextText(text: string): boolean {
  return hasAny(normalizeIntentText(text), [
    "todo 컨텍스트",
    "오늘 할 일 입니다",
    "등록된 항목이 없습니다",
    "- [ ]",
    "- [x]"
  ]);
}

function isListRequest(text: string): boolean {
  return hasAny(text, ["뭐", "무엇", "목록", "보여", "알려", "확인", "남았", "있어", "있나요"]);
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function emptyOutput(): TodoInterpretOutput {
  return {
    handled: false,
    action: "none",
    message: "",
    items: []
  };
}
