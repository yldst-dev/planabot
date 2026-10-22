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
const LEADING_TODO_WORDS = /^(?:(?:오늘|내일)\s+)?(?:(?:해야\s*)?(?:할\s*일|to-?do|투두)(?:\s*(?:리스트|목록))?|체크리스트)(?:\s*(?:에서|중에?|의|에|으로|로)(?=[\s:：]))?(?:\s*[:：])?(?:\s+|(?=[^\s\p{P}]))/iu;
const TRAILING_TODO_WORDS = /(?:^|\s)(?:(?:해야\s*)?(?:할\s*일|to-?do|투두)(?:\s*(?:리스트|목록))?|체크리스트|체크박스|항목|내용|이름|제목|텍스트|문구)(?:에서|중에?|의|에|을|를|은|는)?$/iu;
const POLITE = String.raw`(?:해|해요|해줘|해줘요|해주세요|해주세용|해줄래|해줄래요|해라|줘|줘요|주세요|줄래|줄래요|요|라|주셈|버려|좀)`;
const FILLER_TOKEN = /^(?:좀|제발|부탁|부탁해|부탁해요|부탁합니다|부탁드려요|부탁드립니다|다|전부|모두|싹|방금|지금|이제|아까|오늘|어제|그냥|아|앗|오|와|우와|헐|음|흠|엥|휴|아싸|ㅋ+|ㅎ+|ㅠ+|ㅜ+|ㅇㅇ|[^\p{L}\p{N}]+)$/u;
const DELETE_COMMAND = new RegExp(String.raw`^(?:(?:삭제|지워|지우|제거|없애|빼)${POLITE}?|${POLITE})$`, "u");
const DELETE_SUFFIX = new RegExp(String.raw`(?:삭제|지워|제거|없애|빼)${POLITE}?$`, "u");
const DELETE_TRIGGER = /삭제|지워|제거|지우(?:지|고|면|자|세요|라)|없애|빼(?:줘|주세요|주셈|줄래|라|버려|요)/u;
const COMPLETE_TRIGGER = /완료|끝냈|끝낫|끝냇|끝났|처리했|체크|했어|했습니다|했음|했다|햇어|햇습니다|햇음/u;
const DONE_ENDING = String.raw`(?:${POLITE}|했어|했어요|했습니다|했다|했음|햇어|햇어요|햇습니다|햇음|함|됐어|됐어요|됐음|됨|됐습니다|되었어|되었습니다|처리|표시|어|어요|어용|어여|습니다|슴다|다|음|당)`;
const COMPLETE_COMMAND = new RegExp(String.raw`^(?:(?:완료|체크|처리)${DONE_ENDING}?|(?:끝냈|끝냇|끝났|했|햇|마쳤)(?:어|어요|어용|습니다|다|음|당)?|표시${POLITE}?|${POLITE})$`, "u");
const COMPLETE_SUFFIX = new RegExp(String.raw`(?:완료|체크|처리|끝냈|끝냇|끝났|했|햇|마쳤)${DONE_ENDING}?$`, "u");
const COMPLETION_TOKEN = new RegExp(String.raw`(?:완료|체크|처리|끝냈|끝냇|끝났|끝냄|끝내|마쳤|마침|했|햇|됐|됨|끝)${DONE_ENDING}?$`, "u");
const STEM_ENDING = /(?<!\s)\s*(?:하기|해)$/u;
const NEGATION = /되돌|풀어|원래대로|미완료|취소|해제|(?:하|우|애|빼|치|꾸)지\s*(?:마|말|않)|안\s*해도|하면\s*안\s*(?:돼|되)|(?:완료|체크|삭제|처리)\s*(?:(?:를|을|가|는)\s*)?(?:취소|해제|(?:안|못)\s*(?:됐|돼|됨|했|함))|(?:완료|체크)\s*표시\s*(?:를|을)?\s*(?:지워|지우|삭제|없애|빼|해제|취소|풀)|아니(?:야|에요|요|다|라|잖|지|고)|아닌데|아님/u;
const EXCLUSION = /빼고(?:\s|$)|(?:^|\s)말고(?:\s|$)|제외(?:하고|해)?(?:\s|$)|대신(?:\s|$)/u;
const COMPOUND = /(?:완료|삭제|제거|추가|등록|수정|변경|체크|처리)(?:하|했|해)?고\s|(?:지우|지웠|바꾸|바꿨|고치|고쳤|끝내|끝냈|없애|없앴)고\s|(?:^|\s)(?:하고|했고|하구)\s/u;
const DATE_TIME_ONLY = /^(?:(?:오늘|내일|모레|글피|이번\s*주|다음\s*주|다다음\s*주|주말|평일|\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*일|[월화수목금토일]요일)\s*)*(?:(?:오전|오후|아침|점심|저녁|밤|낮|새벽)\s*)?(?:\d{1,2}\s*시(?:\s*(?:\d{1,2}\s*분|반))?|정오|자정)?$/u;
const NOT_CONTENT = /^(?:상태|날짜|시간|기한|마감|순서|순위|우선\s*순위)(?:을|를|은|는)?(?:\s|$)|^(?:미|안\s*)?완료(?:\s*(?:상태|처리))?$|^(?:완료됨|체크|done|진행\s*중)$|^(?:다\s*)?끝난\s*걸$|^(?:완료\s*)?안\s*한\s*걸$|^(?:맨\s*)?(?:위|아래|앞|뒤|끝|처음|마지막)$|^(?:첫|두|세|네|다섯)\s*번째$|^\d+\s*(?:번|번째|순위)$|(?:\d+\s*(?:분|시간|일|주)|하루|이틀)\s*(?:뒤|후)$|^(?:(?:이번|다음|담|다다음)\s*)?(?:주말|달)$|^\d{1,2}:\d{2}$|^\d{1,2}\/\d{1,2}$|^\d{1,2}\s*[ap]m$|^\d{4}\s*년|(?:이후|이전)$|^(?:담주|다음\s*주|이번\s*주)\s*[월화수목금토일](?:요일|욜)$/iu;
const NOT_ADD_CONTENT = /^(?:다시|그거|이거|저거|그것|이것|저것|그|이|저|하나|뭐|뭔가|(?:방금|아까|위에|아래)\s*(?:거|것|꺼))$/u;
const UPDATE_QUESTION = /(?:수정|변경|바꿔|바꾸|고쳐|고치)(?:해)?(?:도\s*(?:될까|되나|돼|괜찮)|면\s*(?:어때|어떨까|될까|좋을까)|야\s*(?:하나|할까|돼|될까))/u;
const ADD_TAIL = String.raw`(?:해|해요|해줘|해줘요|해주세요|해주세용|해줄래|해줄래요|해라|해둬|해놔|하기|할게|할게요|합니다|줘|줘요|주세요)?(?:\s*(?:좀|제발|부탁(?:해|해요|합니다|드려요|드립니다)?|ㅋ+|ㅎ+))*\s*[.!~]*$`;
const REFUSED_NEGATIVE = "취소나 제외로 읽히는 말이 있어 그대로 두었습니다. 원하는 작업만 다시 말씀해 주십시오.";
const REFUSED_COMPOUND = "여러 작업이 함께 담긴 요청이라 그대로 두었습니다. 한 번에 하나씩 말씀해 주십시오.";
const REFUSED_NOT_CONTENT = "날짜나 시각, 상태, 순서는 할 일 내용으로 바꾸지 않습니다. 완료는 '할 일 1번 완료'처럼 말씀해 주시고, 알림은 일정으로 등록해 주십시오.";
const REFUSED_ADD_CONTENT = "추가할 내용을 확인하지 못했습니다. 예: 할 일에 우유 사기 추가해줘";
const ASK_HEADER = "확인 필요.\n선생님.";
const ASK_MANY = "어느 항목인지 하나로 정하지 못했습니다. 번호로 다시 말씀해 주십시오.";
const ASK_ONE = "이 항목이 맞으면 번호로 다시 말씀해 주십시오.";
const ASK_CONTENT = "새 내용을 확인하지 못했습니다. 바꿀 항목은 번호로, 새 내용은 '로' 앞에 넣어 다시 말씀해 주십시오.";

export type TodoInterpretOutput = {
  handled: boolean;
  action: "none" | "list" | "add" | "complete" | "update" | "delete";
  message: string;
  items: TodoItem[];
  error?: string;
};

export type TodoAction = Exclude<TodoInterpretOutput["action"], "none">;

type Split = { target: string; content: string; at: number };
type Update = { head: string; splits: Split[] };
type Target = { windows: string[]; region: string; core: string };
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
  if (!action && !isTodoRelated(normalized) && !isTodoContextText(text) && !isAskReply(text)) {
    return emptyOutput();
  }
  if (!action && /알림|알려/u.test(normalized) && (/\d{1,2}\s*시(?!간)/u.test(normalized) || normalized.search(NOON_OR_MIDNIGHT_PATTERN) >= 0)) {
    return emptyOutput();
  }
  const open = await openTodos(userId);
  const masked = maskNames(normalized, open);

  const update = !action || action === "update" ? parseUpdate(userText) : undefined;
  if (update) {
    const scope = update === "unclear" ? masked : update.splits.reduce((value, split) => value.replace(split.content.toLowerCase(), " "), masked);
    if (UPDATE_QUESTION.test(normalized) || isDeferred(scope)) {
      return emptyOutput();
    }
    const blocked = blockedReason(scope);
    if (blocked) {
      return refuse("update", userId, blocked);
    }
    if (update === "unclear") {
      return ask("update", userId, open, [], ASK_CONTENT);
    }
    const choice = resolveUpdate(open, update, text);
    if (choice === "unclear") {
      return ask("update", userId, open, [], ASK_CONTENT);
    }
    if (choice && "ask" in choice) {
      return ask("update", userId, open, choice.ask);
    }
    if (choice?.content && (DATE_TIME_ONLY.test(choice.content) || NOT_CONTENT.test(choice.content))) {
      return refuse("update", userId, REFUSED_NOT_CONTENT);
    }
    const result = await updateTodo(userId, choice?.item.id ?? "", choice?.content ?? update.splits[0].content);
    return mutationOutput("update", result.ok ? "수정 완료.\n선생님." : "확인 불가.\n선생님.", result);
  }

  if (action ? action === "delete" : DELETE_TRIGGER.test(masked)) {
    if (isDeferred(masked)) {
      return emptyOutput();
    }
    const blocked = blockedReason(masked);
    if (blocked) {
      return refuse("delete", userId, blocked);
    }
    return mutateChosen("delete", userId, open, text, targetWindows(userText, DELETE_COMMAND, DELETE_SUFFIX), false, deleteTodo, "삭제 완료.\n선생님.");
  }

  if (action ? action === "complete" : COMPLETE_TRIGGER.test(masked)) {
    if (isQuestion(normalized) || isUnfinished(masked)) {
      return emptyOutput();
    }
    const blocked = blockedReason(masked);
    if (blocked) {
      return refuse("complete", userId, blocked);
    }
    const target = completeTarget(userText, text);
    if (endsWithCompletion(userText)) {
      return mutateChosen("complete", userId, open, text, target, true, completeTodo, "완료 처리했습니다.\n선생님.");
    }
    if (!action || !target.core) {
      return emptyOutput();
    }
    const choice = resolveTarget(open, { ...target, windows: [target.core] }, text, false, false);
    if (!choice) {
      return emptyOutput();
    }
    if ("ask" in choice) {
      return ask("complete", userId, open, choice.ask);
    }
    const result = await completeTodo(userId, choice.item.id);
    return mutationOutput("complete", result.ok ? "완료 처리했습니다.\n선생님." : "확인 불가.\n선생님.", result);
  }

  const add = !action || action === "add" ? parseAdd(userText) : undefined;
  if (add !== undefined) {
    if (NEGATION.test(add.rest) || EXCLUSION.test(normalized) || COMPOUND.test(normalized)) {
      return refuse("add", userId, NEGATION.test(add.rest) || EXCLUSION.test(normalized) ? REFUSED_NEGATIVE : REFUSED_COMPOUND);
    }
    if (!add.content || NOT_ADD_CONTENT.test(add.content) || DATE_TIME_ONLY.test(add.content)) {
      return refuse("add", userId, REFUSED_ADD_CONTENT);
    }
    const result = await addTodo(userId, add.content);
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

function blockedReason(text: string): string | undefined {
  return NEGATION.test(text) || EXCLUSION.test(text) ? REFUSED_NEGATIVE : COMPOUND.test(text) ? REFUSED_COMPOUND : undefined;
}

function maskNames(text: string, open: TodoItem[]): string {
  return [...open]
    .sort((a, b) => b.content.length - a.content.length)
    .reduce((value, item) => value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${nameTokens(item.content).join("\\s*")}`, "giu"), " □ "), text)
    .replace(/\s+/gu, " ");
}

function nameTokens(name: string): string[] {
  return name.trim().split(/\s+/u).map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
}

function endsWithCompletion(text: string): boolean {
  const tokens = stripEdgePunctuation(text.replace(/\s+/gu, " ").trim()).split(" ").filter(Boolean);
  let end = tokens.length;
  while (end > 0 && (FILLER_TOKEN.test(tokens[end - 1]) || new RegExp(String.raw`^(?:표시${POLITE}?|${POLITE})$`, "u").test(tokens[end - 1]))) {
    end -= 1;
  }
  return end > 0 && COMPLETION_TOKEN.test(tokens[end - 1]);
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

async function ask(action: TodoAction, userId: string, open: TodoItem[], candidates: TodoItem[], reason?: string): Promise<TodoInterpretOutput> {
  if (!open.length) {
    return refuse(action, userId, "대상 항목을 찾지 못했습니다.");
  }
  const number = (item: TodoItem): number => open.indexOf(item) + 1;
  const first = candidates.length ? number(candidates[0]) : 1;
  const why = reason ?? (candidates.length === 1 ? ASK_ONE : ASK_MANY);
  const example = action === "delete" ? `할 일 ${first}번 삭제해줘` : action === "update" ? `할 일 ${first}번을 새 내용으로 바꿔줘` : `할 일 ${first}번 완료`;
  const lines = [
    ASK_HEADER,
    why,
    ...(candidates.length ? [`후보: ${candidates.map((item) => `${number(item)}번 ${item.content}`).join(", ")}`] : []),
    `예: ${example}`,
    "",
    ...open.map((item, index) => `${index + 1}번 ${item.content}`),
  ];
  const list = await listTodos(userId);
  return {
    handled: true,
    action,
    message: lines.join("\n"),
    items: list.items,
    error: why
  };
}

async function mutateChosen(
  action: TodoAction,
  userId: string,
  open: TodoItem[],
  text: string,
  target: Target,
  mentions: boolean,
  mutate: (userId: string, query: string) => Promise<TodoMutationOutput>,
  donePrefix: string,
): Promise<TodoInterpretOutput> {
  const choice = resolveTarget(open, target, text, mentions);
  if (choice && "ask" in choice) {
    return ask(action, userId, open, choice.ask);
  }
  const result = await mutate(userId, choice?.item.id ?? "");
  return mutationOutput(action, result.ok ? donePrefix : "확인 불가.\n선생님.", result);
}

async function openTodos(userId: string): Promise<TodoItem[]> {
  return (await listTodos(userId)).items.filter((item) => !item.completed);
}

function parseAdd(text: string): { content: string; rest: string } | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/추가|등록/u.test(normalized)) {
    return undefined;
  }
  const stripped = normalized.replace(LEADING_TODO_WORDS, "");
  const candidates: Array<[string, RegExp]> = [
    [stripped, /^(?:추가|등록)(?:해줘|해주세요|해)?\s*[:：]\s*(.+)$/iu],
    [normalized, new RegExp(String.raw`^(.+?)(?:을|를)?\s*(?:할\s*일|todo|투두)(?:에|로)?\s*(?:추가|등록)${ADD_TAIL}`, "iu")],
    [stripped, new RegExp(String.raw`^(.+?)(?:을|를)?\s*(?:추가|등록)${ADD_TAIL}`, "iu")],
  ];
  for (const [value, pattern] of candidates) {
    const match = value.match(pattern);
    if (match?.[1] !== undefined) {
      const content = cleanupTarget(match[1]);
      return { content, rest: normalizeIntentText(value.replace(match[1], " ")) };
    }
  }
  return undefined;
}

function parseUpdate(text: string): Update | "unclear" | undefined {
  const normalized = stripEdgePunctuation(text.replace(/\s+/g, " ").trim().replace(LEADING_TODO_WORDS, ""));
  if (!/수정|변경|바꿔|바꾸|고쳐|고치/u.test(normalized) || /^(?:추가|등록)(?:해줘|해주세요|해)?\s*[:：]|(?:추가|등록)(?:해|해요|해줘|해줘요|해주세요|합니다|해라|하기)?$/u.test(normalized)) {
    return undefined;
  }
  const head = normalized.match(/^(?:수정|변경)(?:해줘|해주세요|해)?\s*[:：]\s*(.+?)(?:으로|로)$/u)?.[1] ?? normalized.match(/^(.+?)(?:으로|로)\s*(?:수정|변경|바꿔|바꾸|고쳐|고치)/u)?.[1];
  if (!head) {
    const verb = /(?:수정|변경|바꿔|고쳐)(?:해|해줘|해줘요|해주세요|줘|하고|해서)?\s+(?=\S)/u.exec(normalized);
    return verb && /(?:으로|로)(?:\s|$)/u.test(normalized.slice(verb.index + verb[0].length)) ? "unclear" : undefined;
  }
  const splits = [...head.matchAll(/(?:을|를|은|는|에서)\s+/gu)]
    .slice(0, MAX_SPLITS)
    .map((particle) => ({ target: head.slice(0, particle.index).trim(), content: cleanContent(head.slice((particle.index ?? 0) + particle[0].length)), at: particle.index ?? 0 }))
    .filter((split) => split.target && split.content);
  return splits.length ? { head, splits } : "unclear";
}

function cleanContent(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[\s:：,.\-]+/u, "")
    .replace(/^(?:→|->|=>|>|대신|그냥|다시|걍|(?:이름|제목|텍스트|문구|내용)(?:을|를)?)\s+/u, "")
    .replace(/^['"“‘]+|['"”’]+$/gu, "")
    .trim();
}

function resolveUpdate(open: TodoItem[], update: Update, fullText: string): Choice | "unclear" | undefined {
  const entries = indexTodos(open);
  const context = extractOpenTodosFromContext(fullText);
  const splits = update.splits.filter((split) => !open.some((item) => {
    const found = mentionPattern(item.content).exec(update.head);
    return found !== null && found.index < split.at && found.index + found[0].length > split.at;
  }));
  if (!splits.length) {
    return "unclear";
  }
  const select = (items: Entry[], value: string): TodoItem[] => selectedItems(items, value, context, fullText);
  for (const tier of [exactItems, stemItems, select]) {
    const readings = splits.flatMap((split) => variants(split.target).flatMap((value) => {
      const hits = tier(entries, value);
      const wider = hits.length && tier !== select ? [...select(entries, value), ...(value !== split.target ? prefixItems(entries, split.target) : [])] : [];
      return [...hits, ...wider];
    }).map((item) => ({ item, content: split.content })));
    const distinct = [...new Map(readings.map((reading) => [`${reading.item.id}\n${reading.content}`, reading])).values()];
    if (distinct.length === 1) {
      return distinct[0];
    }
    if (distinct.length > 1) {
      return { ask: uniqueItems(distinct.map((reading) => reading.item)) };
    }
  }
  const partial = uniqueItems(splits.flatMap((split) => variants(split.target).flatMap((value) => partialItems(entries, value))));
  return partial.length ? { ask: partial } : undefined;
}

function resolveTarget(open: TodoItem[], target: Target, fullText: string, mentions: boolean, partial = true): Choice | undefined {
  const entries = indexTodos(open);
  const context = extractOpenTodosFromContext(fullText);
  const select = (items: Entry[], value: string): TodoItem[] => selectedItems(items, value, context, fullText);
  for (const tier of [exactItems, stemItems, select]) {
    const found: TodoItem[] = [];
    for (const window of target.windows) {
      for (const value of variants(window)) {
        const hits = tier(entries, value);
        found.push(...hits);
        if (hits.length && tier !== select) {
          found.push(...select(entries, value), ...(value !== window ? prefixItems(entries, window) : []));
        }
      }
    }
    const unique = uniqueItems(found);
    if (unique.length) {
      return unique.length === 1 ? { item: unique[0] } : { ask: unique };
    }
  }
  if (mentions && target.region) {
    const found = leadingItems(entries, target.region);
    if (found.length) {
      return found.length === 1 ? { item: found[0] } : { ask: found };
    }
  }
  const near = partial ? uniqueItems(target.windows.flatMap(variants).flatMap((value) => partialItems(entries, value))) : [];
  return near.length ? { ask: near } : undefined;
}

function targetWindows(text: string, command: RegExp, suffix: RegExp): Target {
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
  for (let start = 0; start <= lead; start += 1) {
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
  return { windows: [...new Set(windows)], region: tokens.slice(lead).join(" "), core: tokens.slice(lead, tail).join(" ") };
}

function completeTarget(userText: string, fullText: string): Target {
  const target = targetWindows(userText.replace(/^(?:네|예|응|그래|넵)(?:[,.!]+\s*|\s*$)/u, ""), COMPLETE_COMMAND, COMPLETE_SUFFIX);
  if (target.windows.length) {
    return target;
  }
  const single = extractSingleOpenTodoFromContext(fullText);
  return single ? { windows: [single], region: single, core: single } : target;
}

function variants(window: string): string[] {
  const values = [window, window.replace(TRAILING_TODO_WORDS, "").trim()];
  return [...new Set(values.flatMap((value) => [value, value.replace(/(?:을|를|은|는|이|가|도|에서|좀)$/u, "").trim()]))].filter(Boolean);
}

function indexTodos(open: TodoItem[]): Entry[] {
  return open.map((item) => ({ item, key: compact(item.content), stem: compact(item.content.replace(STEM_ENDING, "")), mention: mentionPattern(item.content) }));
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

function selectedItems(entries: Entry[], value: string, context: string[], fullText: string): TodoItem[] {
  if (isAskReply(fullText) && !/^\d+번?$/u.test(normalizeSelectorText(value))) {
    return [];
  }
  const index = parseTodoSelectorIndex(value, context.length || entries.length);
  if (index === undefined) {
    return [];
  }
  const chosen = context.length ? exactItems(entries, context[index]) : [entries[index].item];
  const word = normalizeSelectorText(value).replace(/^맨/u, "").replace(/(?:거|것|꺼|항목)$/u, "");
  const named = entries.filter((entry) => {
    const head = entry.item.content.trim().split(/\s+/u)[0] ?? "";
    const number = entry.item.content.trim().match(/^(\d+)(?:번|번째|째)?(?:\s|$)/u)?.[1];
    return (word && entry.key.startsWith(word)) || (/^(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열|마지막|처음|\d+(?:번|번째|째)?)$/u.test(head) && compact(head) === word) || Number(number) === index + 1;
  });
  return uniqueItems([...chosen, ...named.map((entry) => entry.item)]);
}

function isAskReply(text: string): boolean {
  const marker = text.lastIndexOf("질문:");
  const context = marker >= 0 ? text.slice(0, marker) : "";
  return context.includes(ASK_HEADER) && context.includes("\n예: 할 일 ");
}

function prefixItems(entries: Entry[], value: string): TodoItem[] {
  const key = compact(value);
  return key ? entries.filter((entry) => entry.key.startsWith(key)).map((entry) => entry.item) : [];
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

function leadingItems(entries: Entry[], region: string): TodoItem[] {
  const found = entries.map((entry) => entry.item).flatMap((item) => {
    const stem = item.content.replace(STEM_ENDING, "");
    if (mentionPattern(item.content).exec(region)?.index === 0) {
      return [{ item, name: compact(item.content), full: true }];
    }
    return stem !== item.content && compact(stem).length >= 2 && mentionPattern(stem).exec(region)?.index === 0 ? [{ item, name: compact(stem), full: false }] : [];
  });
  const kept = found.filter((entry) => !found.some((other) => (other.name.length > entry.name.length && other.name.includes(entry.name)) || (other.name === entry.name && other.full && !entry.full)));
  const base = compact((region.split(" ")[0] ?? "").replace(/(?:을|를|은|는|이|가|도|만|에서|좀)$/u, ""));
  const wider = kept.some((entry) => base.length > entry.name.length && base.startsWith(entry.name)) ? prefixItems(entries, base) : [];
  return uniqueItems([...kept.map((entry) => entry.item), ...wider]);
}

function mentionPattern(name: string): RegExp {
  const tokens = name.trim().split(/\s+/u).map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])${tokens.join("\\s*")}(?=$|[\\s\\p{P}]|을|를|은|는|이|가|도|만|완료|했|함|끝|처리|체크)`, "iu");
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
  return (/[?？][\sㅋㅎㅠㅜ~!.]*$/u.test(text) && !/(?:줄래|줄래요|주실래요|주시겠어요|해줘|줘요|주세요)\s*[?？][\sㅋㅎㅠㅜ~!.]*$/u.test(text)) || /했(?:나|니|냐|는지)/u.test(text);
}

function isUnfinished(text: string): boolean {
  return /안\s*(?:했|끝)|못\s*(?:했|끝)|아직|않았|하려|하라고|할까|했어야|해야\s*했(?!던)|할\s*(?:거(?:야|예|에|임|라|다|였|고|니|면|래|냐|지|잖|거든|\s*같)|건(?:데|지|가))|깜빡|까먹|잊어|포기|(?:하|끝나|끝내|마치|되)면|하고\s*나서|한\s*(?:다음|뒤|후)|끝난\s*(?:뒤|후|다음)|했대|했다고|했다는|하래|하랬|라고|시작했|반만|반쯤|절반|일부|거의|조금|준비만|예약만|하는\s*중|중이|돼\s*있|됐나|됐는지|했었나|했던가|버튼|기능|어떻게|고\s*나서|고\s*난\s*(?:다음|뒤|후)|[가-힣]고\s+(?:완료|체크|처리)|(?<!\d)\d+\s*(?:%|퍼센트|프로)/u.test(text);
}

function isDeferred(text: string): boolean {
  return isQuestion(text) || /(?:하|끝나|끝내|마치|되)면(?:\s|$)|하고\s*나서|한\s*(?:다음|뒤|후)|끝난\s*(?:뒤|후|다음)|했대|했다고|했다는|하래|하랬|라고\s*(?:했|하더|해서)|나중에|이따/u.test(text);
}

function extractSingleOpenTodoFromContext(text: string): string | undefined {
  const openItems = extractOpenTodosFromContext(text);
  const uniqueItems = [...new Set(openItems)];
  return uniqueItems.length === 1 ? uniqueItems[0] : undefined;
}

function extractOpenTodosFromContext(text: string): string[] {
  const listed = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*\[\s\]\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter((item) => item && item !== "등록된 항목이 없습니다.");
  if (listed.length) {
    return listed;
  }
  const marker = text.lastIndexOf("질문:");
  const numbered = (marker >= 0 ? text.slice(0, marker) : "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d{1,3})번\s+(.+)$/u);
      return match ? [{ number: Number(match[1]), name: match[2].trim() }] : [];
    });
  return numbered.length && numbered.every((entry, index) => entry.number === index + 1) ? numbered.map((entry) => entry.name) : [];
}

function parseTodoSelectorIndex(target: string, itemCount: number): number | undefined {
  if (itemCount <= 0 || /\d[\s,.\-()]+\d/u.test(target)) {
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
