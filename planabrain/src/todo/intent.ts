import {
  addTodo,
  completeTodo,
  deleteTodo,
  listTodos,
  updateTodo,
  type TodoItem,
  type TodoMutationOutput
} from "./store.js";
import { NOON_OR_MIDNIGHT_PATTERN } from "../schedule/intent.js";

const MAX_RULE_TEXT_CHARS = 600;
const MAX_SPLITS = 10;
const LEADING_TODO_WORDS = /^(?:(?:오늘|내일)\s+)?(?:(?:해야\s*)?(?:할\s*일|to-?do|투두)(?:\s*(?:리스트|목록))?|체크리스트)(?:\s*(?:에서|중에?|의|에))?\s+/iu;
const TRAILING_TODO_WORDS = /(?:^|\s)(?:(?:해야\s*)?(?:할\s*일|to-?do|투두)(?:\s*(?:리스트|목록))?|체크리스트|체크박스|항목|내용)(?:에서|중에?|의|에|을|를|은|는)?$/iu;
const POLITE = String.raw`(?:해|해요|해줘|해줘요|해주세요|해줄래|해줄래요|해라|줘|줘요|주세요|줄래|줄래요)`;
const FILLER_TOKEN = /^(?:좀|제발|부탁|부탁해|부탁해요|부탁합니다|다|전부|모두|싹|방금|지금|이제|아까|오늘|어제)$/u;
const DELETE_COMMAND = new RegExp(String.raw`^(?:(?:삭제|지워|지우|제거|없애)${POLITE}?|${POLITE})$`, "u");
const DELETE_SUFFIX = new RegExp(String.raw`(?:삭제|지워|제거|없애)${POLITE}?$`, "u");
const COMPLETE_COMMAND = new RegExp(String.raw`^(?:(?:완료|체크|처리)(?:${POLITE}|했어|했어요|했습니다|했다|했음|함|처리|표시)?|(?:끝냈|끝났|했)(?:어|어요|습니다|다|음)?|${POLITE})$`, "u");
const COMPLETE_SUFFIX = new RegExp(String.raw`(?:완료|체크|처리|끝냈|끝났|했)(?:${POLITE}|했어|했어요|했습니다|했다|했음|함|어|어요|습니다|다|음)?$`, "u");
const STEM_ENDING = /(?<!\s)\s*(?:하기|해)$/u;
const SELECTOR_SUFFIX = /^(?:번째|번|째|거|것|꺼|항목)(?=\s|$)/u;
const NEGATION = /(?:하|우|애|빼|치|꾸)지\s*(?:마|말|않)|안\s*해도|하면\s*안\s*(?:돼|되)|(?:완료|체크|삭제|처리)\s*(?:(?:를|을|가|는)\s*)?(?:취소|해제|(?:안|못)\s*(?:됐|돼|됨|했|함))|(?:완료|체크)\s*표시|아니(?:야|에요|요|다|라|잖|지|고)|아닌데|아님/u;
const EXCLUSION = /빼고(?:\s|$)|(?:^|\s)말고(?:\s|$)|제외(?:하고|해)?(?:\s|$)/u;
const COMPOUND = /(?:완료|삭제|제거|추가|등록|수정|변경|체크|처리)(?:하|했|해)?고\s|(?:지우|지웠|바꾸|바꿨|고치|고쳤|끝내|끝냈|없애|없앴)고\s/u;
const DATE_TIME_ONLY = /^(?:(?:오늘|내일|모레|글피|이번\s*주|다음\s*주|다다음\s*주|주말|평일|\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*일|[월화수목금토일]요일)\s*)*(?:(?:오전|오후|아침|점심|저녁|밤|낮|새벽)\s*)?(?:\d{1,2}\s*시(?:\s*(?:\d{1,2}\s*분|반))?|정오|자정)?$/u;
const REFUSED_NEGATIVE = "부정이나 취소, 제외가 담긴 요청이라 그대로 두었습니다.";
const REFUSED_COMPOUND = "여러 작업이 함께 담긴 요청이라 그대로 두었습니다. 한 번에 하나씩 말씀해 주십시오.";
const REFUSED_DATE_ONLY = "날짜나 시각만으로는 할 일 내용을 바꾸지 않습니다. 알림이 필요하면 일정으로 등록해 주십시오.";
const ASK_TARGET = "어느 항목인지 하나로 정하지 못했습니다. 번호로 다시 말씀해 주십시오.";

export type TodoInterpretOutput = {
  handled: boolean;
  action: "none" | "list" | "add" | "complete" | "update" | "delete";
  message: string;
  items: TodoItem[];
  error?: string;
};

export type TodoAction = Exclude<TodoInterpretOutput["action"], "none">;

type Split = { target: string; content: string; particle: boolean };
type Entry = { item: TodoItem; key: string; stem: string; mention: RegExp };
type Choice = { item: TodoItem; content?: string } | { ask: TodoItem[] };

export async function interpretTodoRequest(
  userId: string,
  text: string,
  action?: TodoAction,
): Promise<TodoInterpretOutput> {
  const userText = extractUserText(text);
  if (userText.length > MAX_RULE_TEXT_CHARS && action !== "list") {
    return emptyOutput();
  }
  const normalized = normalizeIntentText(userText);
  const todoRelated = action !== undefined || isTodoRelated(normalized) || isTodoContextText(text);
  if (!action && todoRelated && /알림|알려/u.test(normalized) && (/\d{1,2}\s*시(?!간)/u.test(normalized) || normalized.search(NOON_OR_MIDNIGHT_PATTERN) >= 0)) {
    return emptyOutput();
  }
  const blocked = NEGATION.test(normalized) || EXCLUSION.test(normalized) ? REFUSED_NEGATIVE : COMPOUND.test(normalized) ? REFUSED_COMPOUND : undefined;

  const update = action === "update" || (!action && todoRelated) ? parseUpdate(userText) : undefined;
  if (update) {
    if (blocked) {
      return refuse("update", userId, blocked);
    }
    const open = await openTodos(userId);
    const choice = resolveUpdate(open, update, text);
    if (choice && "ask" in choice) {
      return ask("update", userId, open, choice.ask);
    }
    if (choice?.content && DATE_TIME_ONLY.test(choice.content)) {
      return refuse("update", userId, REFUSED_DATE_ONLY);
    }
    const result = await updateTodo(userId, choice?.item.id ?? "", choice?.content ?? update[0].content);
    return mutationOutput("update", result.ok ? "수정 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (action ? action === "delete" : todoRelated && /삭제|지워|제거|지우(?:지|고|면|자|세요|라)/u.test(normalized)) {
    if (blocked) {
      return refuse("delete", userId, blocked);
    }
    return mutateChosen("delete", userId, text, targetWindows(userText, DELETE_COMMAND, DELETE_SUFFIX), false, deleteTodo, "삭제 완료.\n선생님.");
  }

  if (action ? action === "complete" : hasAny(normalized, ["완료", "끝냈", "끝낫", "처리했", "체크", "했어", "했습니다"]) && !isQuestion(normalized) && !isUnfinished(normalized)) {
    if (isUnfinished(normalized)) {
      return emptyOutput();
    }
    if (blocked) {
      return todoRelated ? refuse("complete", userId, blocked) : emptyOutput();
    }
    if (!todoRelated) {
      const mentioned = mentionedItems(await openTodos(userId), userText, false);
      if (mentioned.length !== 1) {
        return emptyOutput();
      }
      const result = await completeTodo(userId, mentioned[0].id);
      return result.ok ? mutationOutput("complete", "완료 처리했습니다.\n선생님.", result) : emptyOutput();
    }
    return mutateChosen("complete", userId, text, completeWindows(userText, text), true, completeTodo, "완료 처리했습니다.\n선생님.");
  }

  if (!todoRelated) {
    return emptyOutput();
  }

  const add = !action || action === "add" ? parseAdd(userText, todoRelated) : undefined;
  if (add) {
    if (NEGATION.test(normalized) || COMPOUND.test(normalized)) {
      return refuse("add", userId, NEGATION.test(normalized) ? REFUSED_NEGATIVE : REFUSED_COMPOUND);
    }
    const result = await addTodo(userId, add);
    return mutationOutput("add", result.ok ? "등록 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (action ? action === "list" : isListRequest(normalized)) {
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

const DONE_LINES: Partial<Record<TodoInterpretOutput["action"], string>> = {
  add: "항목을 추가했습니다.",
  complete: "항목을 완료했습니다.",
  update: "항목으로 고쳤습니다.",
  delete: "항목을 지웠습니다."
};

function mutationOutput(
  action: TodoInterpretOutput["action"],
  prefix: string,
  result: {
    ok: boolean;
    item?: TodoItem;
    items: TodoItem[];
    markdown: string;
    error?: string;
  }
): TodoInterpretOutput {
  const detail = result.item && DONE_LINES[action] ? `\n"${result.item.content}" ${DONE_LINES[action]}` : "";
  const message = result.ok
    ? `${prefix}${detail}\n\n${result.markdown}`
    : `${prefix}\n${result.error ?? "작업을 처리하지 못했습니다."}\n\n${result.markdown}`;
  return {
    handled: true,
    action,
    message,
    items: result.items,
    ...(result.error ? { error: result.error } : {})
  };
}

async function refuse(action: TodoAction, userId: string, error: string): Promise<TodoInterpretOutput> {
  const list = await listTodos(userId);
  return mutationOutput(action, "확인 불가.\n선생님.", { ok: false, items: list.items, markdown: list.markdown, error });
}

async function ask(action: TodoAction, userId: string, open: TodoItem[], candidates: TodoItem[]): Promise<TodoInterpretOutput> {
  const list = await listTodos(userId);
  const lines = candidates.map((item) => `${open.indexOf(item) + 1}번 ${item.content}`);
  const first = open.indexOf(candidates[0]) + 1;
  const example = action === "delete" ? `할 일 ${first}번 삭제해줘` : action === "update" ? `할 일 ${first}번을 새 내용으로 바꿔줘` : `할 일 ${first}번 완료`;
  return {
    handled: true,
    action,
    message: `확인 필요.\n선생님.\n${ASK_TARGET}\n${lines.join("\n")}\n예: ${example}\n\n${list.markdown}`,
    items: list.items,
    error: ASK_TARGET
  };
}

async function mutateChosen(
  action: TodoAction,
  userId: string,
  text: string,
  windows: string[],
  mentions: boolean,
  mutate: (userId: string, query: string) => Promise<TodoMutationOutput>,
  donePrefix: string,
): Promise<TodoInterpretOutput> {
  const open = await openTodos(userId);
  const choice = resolveTarget(open, windows, text, mentions);
  if (choice && "ask" in choice) {
    return ask(action, userId, open, choice.ask);
  }
  const result = await mutate(userId, choice?.item.id ?? "");
  return mutationOutput(action, result.ok ? donePrefix : "확인 불가.\n선생님.", result);
}

async function openTodos(userId: string): Promise<TodoItem[]> {
  return (await listTodos(userId)).items.filter((item) => !item.completed);
}

function parseAdd(text: string, allowImplicit: boolean): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/추가|등록/u.test(normalized)) {
    return undefined;
  }
  const patterns = [
    /(?:할\s*일|todo|투두)(?:에|로)?\s+(.+?)(?:을|를)?\s*(?:추가|등록)/i,
    /(?:추가|등록)(?:해줘|해주세요|해|합니다|해라)?[:\s]+(.+)/i,
    /^(.+?)(?:을|를)?\s*(?:할\s*일|todo|투두)(?:에|로)?\s*(?:추가|등록)/i
  ];
  if (allowImplicit) {
    patterns.push(/^(.+?)(?:을|를)?\s*(?:추가|등록)(?:해줘|해주세요|해|합니다|해라)?$/i);
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

function parseUpdate(text: string): Split[] | undefined {
  const normalized = stripEdgePunctuation(text.replace(/\s+/g, " ").trim().replace(LEADING_TODO_WORDS, ""));
  if (!/수정|변경|바꿔|바꾸|고쳐|고치/u.test(normalized) || /^(?:추가|등록)|(?:추가|등록)(?:해|해요|해줘|해줘요|해주세요|합니다|해라|하기)?$/u.test(normalized)) {
    return undefined;
  }
  const splits: Split[] = [];
  const head = normalized.match(/^(.+?)(?:으로|로)\s*(?:수정|변경|바꿔|바꾸|고쳐|고치)/u)?.[1];
  if (head) {
    for (const particle of [...head.matchAll(/(?:을|를)\s+/gu)].slice(0, MAX_SPLITS)) {
      splits.push({ target: head.slice(0, particle.index), content: head.slice((particle.index ?? 0) + particle[0].length), particle: true });
    }
    const words = head.split(" ");
    for (let index = 1; index < Math.min(words.length, MAX_SPLITS + 1); index += 1) {
      splits.push({ target: words.slice(0, index).join(" "), content: words.slice(index).join(" "), particle: false });
    }
  }
  const verb = /(?:(?:을|를)\s?)?(?:수정|변경|바꿔|고쳐)(?:해|해줘|해줘요|해주세요|줘|하고|해서)?\s/u.exec(normalized);
  if (verb && verb.index > 0) {
    const content = normalized.slice(verb.index + verb[0].length).match(/^(.+?)(?:으로|로)(?:\s*(?:해|해줘|해줘요|해주세요|줘|부탁해|바꿔줘|변경해줘|수정해줘|고쳐줘))?$/u)?.[1];
    if (content) {
      splits.push({ target: normalized.slice(0, verb.index), content, particle: true });
    }
  }
  const cleaned = splits
    .map((split) => ({ ...split, target: split.target.trim(), content: cleanupTarget(split.content) }))
    .filter((split) => split.target && split.content);
  return cleaned.length ? cleaned : undefined;
}

function resolveUpdate(open: TodoItem[], splits: Split[], fullText: string): Choice | undefined {
  const entries = indexTodos(open);
  const context = extractOpenTodosFromContext(fullText);
  const tiers = [exactItems, stemItems, (items: Entry[], value: string) => selectedItems(items, value, context)];
  const groups = splits.some((split) => split.particle) ? [splits.filter((split) => split.particle), splits.filter((split) => !split.particle)] : [splits];
  for (const group of groups) {
    for (const [rank, tier] of tiers.entries()) {
      const readings = group.flatMap((split) =>
        rank === 2 && SELECTOR_SUFFIX.test(split.content)
          ? []
          : variants(split.target).flatMap((value) => tier(entries, value)).map((item) => ({ item, content: split.content })),
      );
      const distinct = [...new Map(readings.map((reading) => [`${reading.item.id}\n${reading.content}`, reading])).values()];
      if (distinct.length === 1) {
        return distinct[0];
      }
      if (distinct.length > 1) {
        return { ask: uniqueItems(distinct.map((reading) => reading.item)) };
      }
    }
  }
  const partial = uniqueItems(splits.flatMap((split) => variants(split.target).flatMap((value) => partialItems(entries, value))));
  return partial.length ? { ask: partial } : undefined;
}

function resolveTarget(open: TodoItem[], windows: string[], fullText: string, mentions: boolean): Choice | undefined {
  const entries = indexTodos(open);
  const values = [...new Set(windows.flatMap(variants))];
  const context = extractOpenTodosFromContext(fullText);
  const tiers = [exactItems, stemItems, (items: Entry[], value: string) => selectedItems(items, value, context)];
  for (const tier of tiers) {
    const found = uniqueItems(values.flatMap((value) => tier(entries, value)));
    if (found.length) {
      return found.length === 1 ? { item: found[0] } : { ask: found };
    }
  }
  if (mentions && windows.length) {
    const found = mentionedItems(open, windows[0], true);
    if (found.length) {
      return found.length === 1 ? { item: found[0] } : { ask: found };
    }
  }
  const partial = uniqueItems(values.flatMap((value) => partialItems(entries, value)));
  return partial.length ? { ask: partial } : undefined;
}

function targetWindows(text: string, command: RegExp, suffix: RegExp): string[] {
  const tokens = stripEdgePunctuation(text.replace(/\s+/gu, " ").trim().replace(LEADING_TODO_WORDS, "")).split(" ").filter(Boolean);
  const skippable = (token: string): boolean => command.test(token) || FILLER_TOKEN.test(token);
  let lead = 0;
  while (lead < tokens.length && skippable(tokens[lead])) {
    lead += 1;
  }
  let tail = tokens.length;
  while (tail > lead && skippable(tokens[tail - 1])) {
    tail -= 1;
  }
  const ends = [...new Set([0, 1, 2, 3].map((strip) => tokens.length - strip).filter((end) => end > tail).concat(tail))];
  const windows: string[] = [];
  for (const start of new Set([0, lead])) {
    for (const end of ends) {
      const slice = tokens.slice(start, end);
      if (!slice.length || slice.every(skippable)) {
        continue;
      }
      windows.push(slice.join(" "));
      const last = slice[slice.length - 1].replace(suffix, "");
      if (last && last !== slice[slice.length - 1]) {
        windows.push([...slice.slice(0, -1), last].join(" "));
      }
    }
  }
  return [...new Set(windows)];
}

function completeWindows(userText: string, fullText: string): string[] {
  const windows = targetWindows(userText.replace(/^(?:네|예|응|그래|넵)(?:[,.!]+\s*|\s*$)/u, ""), COMPLETE_COMMAND, COMPLETE_SUFFIX);
  if (windows.length) {
    return windows;
  }
  const single = extractSingleOpenTodoFromContext(fullText);
  return single ? [single] : [];
}

function variants(window: string): string[] {
  const values = [window, window.replace(TRAILING_TODO_WORDS, "").trim()];
  return [...new Set(values.flatMap((value) => [value, value.replace(/(?:을|를|은|는|이|가|도|에서|좀)$/u, "").trim()]))].filter(Boolean);
}

function indexTodos(open: TodoItem[]): Entry[] {
  return open.map((item) => ({ item, key: compact(item.content), stem: compact(item.content.replace(STEM_ENDING, "")), mention: mentionPattern(item.content, true) }));
}

function exactItems(entries: Entry[], value: string): TodoItem[] {
  const key = compact(value);
  return key ? entries.filter((entry) => entry.key === key).map((entry) => entry.item) : [];
}

function stemItems(entries: Entry[], value: string): TodoItem[] {
  const key = compact(value);
  const keyStem = compact(value.replace(STEM_ENDING, ""));
  if (key.length < 2) {
    return [];
  }
  return entries
    .filter((entry) => (entry.stem !== entry.key && entry.stem === key) || (keyStem !== key && keyStem.length >= 2 && keyStem === entry.key))
    .map((entry) => entry.item);
}

function selectedItems(entries: Entry[], value: string, context: string[]): TodoItem[] {
  const index = parseTodoSelectorIndex(value, context.length || entries.length);
  if (index === undefined) {
    return [];
  }
  return context.length ? exactItems(entries, context[index]) : [entries[index].item];
}

function partialItems(entries: Entry[], value: string): TodoItem[] {
  const key = compact(value);
  if (!key) {
    return [];
  }
  const wordStart = new RegExp(`(?<![\\p{L}\\p{N}])${value.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "iu");
  return entries
    .filter((entry) => (key.length >= 2 && entry.key.includes(key)) || wordStart.test(entry.item.content) || entry.mention.test(value))
    .map((entry) => entry.item);
}

function mentionedItems(open: TodoItem[], text: string, wholeWord: boolean): TodoItem[] {
  const found = open.flatMap((item) => {
    const stem = item.content.replace(STEM_ENDING, "");
    if (mentionsTodo(text, item.content, wholeWord)) {
      return [{ item, name: compact(item.content), full: true }];
    }
    return stem !== item.content && compact(stem).length >= 2 && mentionsTodo(text, stem, wholeWord) ? [{ item, name: compact(stem), full: false }] : [];
  });
  return found
    .filter((entry) => !found.some((other) => (other.name.length > entry.name.length && other.name.includes(entry.name)) || (other.name === entry.name && other.full && !entry.full)))
    .map((entry) => entry.item);
}

function mentionsTodo(text: string, name: string, wholeWord: boolean): boolean {
  return mentionPattern(name, wholeWord).test(text);
}

function mentionPattern(name: string, wholeWord: boolean): RegExp {
  const tokens = name.trim().split(/\s+/u).map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`${wholeWord ? "(?<![\\p{L}\\p{N}])" : ""}${tokens.join("\\s*")}(?=$|[\\s\\p{P}]|을|를|은|는|이|가|도|만|완료|했|함|끝|처리|체크)`, "iu");
}

function uniqueItems(items: TodoItem[]): TodoItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[\s()[\]{}"'`.,!?。！？:：~…-]/gu, "");
}

function stripEdgePunctuation(value: string): string {
  return value.replace(/(?<![\s.,!?~…])[\s.,!?~…]+$/u, "");
}

function isQuestion(text: string): boolean {
  return /[?？]\s*$|했(?:나|니|냐|는지)/u.test(text);
}

function isUnfinished(text: string): boolean {
  return /안\s*(?:했|끝)|못\s*(?:했|끝)|아직|않았|하려|하라고|할까|했어야|해야\s*했(?!던)|할\s*(?:거(?:야|예|에|임|라|다|였|고|니|면|래|냐|지|잖|거든|\s*같)|건(?:데|지|가))|깜빡|까먹|잊어|포기/u.test(text);
}

function extractSingleOpenTodoFromContext(text: string): string | undefined {
  const openItems = extractOpenTodosFromContext(text);
  const uniqueItems = [...new Set(openItems)];
  return uniqueItems.length === 1 ? uniqueItems[0] : undefined;
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
    ["첫번째", "첫째", "처음", "맨위", "맨첫", "맨처음", "일번", "일번째"],
    ["두번째", "둘째"],
    ["세번째", "셋째", "삼번", "삼번째"],
    ["네번째", "넷째", "사번", "사번째"],
    ["다섯번째", "다섯째", "오번", "오번째"],
    ["여섯번째", "여섯째", "육번", "육번째"],
    ["일곱번째", "일곱째", "칠번", "칠번째"],
    ["여덟번째", "여덟째", "팔번", "팔번째"],
    ["아홉번째", "아홉째", "구번", "구번째"],
    ["열번째", "열째", "십번", "십번째"]
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
  return /할\s*일|to-?do|투두|체크리스트/u.test(text);
}

function isTodoContextText(text: string): boolean {
  return hasAny(normalizeIntentText(text), [
    "todo 컨텍스트",
    "오늘 할 일 입니다",
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
