import { checkExecution } from "../runtime/execution.js";
import { loadDecisionEvaluator } from "./config.js";
import { type DecisionEvaluator, type SystemOneAnswer, type SystemOneQuestion } from "./systemOne.js";

export const TURN_ROUTES = [
  "chat",
  "todo_add",
  "todo_complete",
  "todo_delete",
  "todo_update",
  "todo_list",
  "schedule_add",
  "schedule_cancel",
  "schedule_list",
] as const;

export type TurnRoute = (typeof TURN_ROUTES)[number];

export type TurnSignals = {
  route: TurnRoute;
  routeConfident: boolean;
  currentInfo: boolean;
  searchFollowUp: boolean;
  socialOnly: boolean;
};

export type TurnClassificationInput = {
  message: string;
  previousUserMessage?: string;
  memories?: Array<{ id: number; content: string; }>;
};

export type TurnClassification = {
  signals: TurnSignals;
  relevantMemoryIds: Set<number>;
};

const ROUTE_CONFIDENCE = 0.6;
const CURRENT_INFO_THRESHOLD = 0.7;
const FOLLOW_UP_THRESHOLD = 0.7;
const SOCIAL_THRESHOLD = 0.8;
const MEMORY_THRESHOLD = 0.45;
const MAX_STATE_CHARS = 2000;

const ROUTE_QUESTION: SystemOneQuestion = {
  type: "choice",
  instructions:
    "마지막 사용자 메시지가 봇의 할 일 목록 기능이나 일정·알림 기능을 실행해 달라는 요청인지 고릅니다. 지나간 일을 말하거나 일반 대화, 질문이면 chat입니다.",
  criteria: {
    chat: "일반 대화, 질문, 감상, 지나간 일 이야기. 기능 실행 요청이 아님",
    todo_add: "할 일 목록에 새 항목을 추가해 달라는 요청",
    todo_complete: "할 일 목록에 있는 항목을 완료 처리해 달라는 요청",
    todo_delete: "할 일 목록에서 항목을 지워 달라는 요청",
    todo_update: "할 일 목록에 있는 항목의 내용을 바꿔 달라는 요청",
    todo_list: "할 일 목록을 보여 달라는 요청",
    schedule_add: "정한 시각이나 시간 뒤에 알림, 일정, 타이머를 등록해 달라는 요청",
    schedule_cancel: "등록된 알림이나 일정을 취소해 달라는 요청",
    schedule_list: "등록된 알림이나 일정을 보여 달라는 요청",
  },
};

const CURRENT_INFO_QUESTION: SystemOneQuestion = {
  type: "noul",
  instructions:
    "마지막 사용자 메시지에 답하려면 날씨, 시세, 환율, 뉴스, 경기 결과, 운행 정보처럼 지금 시점의 외부 정보를 웹에서 확인해야 하는가? 그런 낱말이 감상이나 잡담에 나오기만 한 경우는 아니다.",
};

const FOLLOW_UP_QUESTION: SystemOneQuestion = {
  type: "noul",
  instructions:
    "마지막 사용자 메시지가 직전 사용자 메시지의 정보 요청을 정정하거나 대상을 바꾸거나 보충하는 후속 질문인가? 감사 인사, 맞장구, 관계없는 새 주제는 아니다.",
};

const SOCIAL_QUESTION: SystemOneQuestion = {
  type: "noul",
  instructions:
    "마지막 사용자 메시지가 인사, 감사, 안부처럼 짧은 사교적 말뿐이고 따로 답해야 할 내용이 없는가?",
};

export async function classifyTurn(
  input: TurnClassificationInput,
  evaluator: DecisionEvaluator | undefined = loadDecisionEvaluator(),
): Promise<TurnClassification | undefined> {
  const message = input.message.trim().slice(0, MAX_STATE_CHARS);
  if (!evaluator || !message) {
    return undefined;
  }
  const previous = input.previousUserMessage?.trim().slice(0, MAX_STATE_CHARS);
  const questions: Record<string, SystemOneQuestion> = {
    route: ROUTE_QUESTION,
    current_info: CURRENT_INFO_QUESTION,
    social: SOCIAL_QUESTION,
    ...(previous ? { follow_up: FOLLOW_UP_QUESTION } : {}),
    ...Object.fromEntries((input.memories ?? []).map((memory) => [`memory_${memory.id}`, memoryQuestion(memory.content)])),
  };
  const state = previous
    ? { previous_user_message: previous, last_user_message: message }
    : { last_user_message: message };
  const startedAt = Date.now();
  try {
    const answers = await evaluator.evaluate(state, questions);
    const route = answers.route.type === "choice" ? answers.route : undefined;
    const signals: TurnSignals = {
      route: (route?.choice ?? "chat") as TurnRoute,
      routeConfident: (route?.confidence ?? 0) >= ROUTE_CONFIDENCE,
      currentInfo: probability(answers.current_info) >= CURRENT_INFO_THRESHOLD,
      searchFollowUp: probability(answers.follow_up) >= FOLLOW_UP_THRESHOLD,
      socialOnly: probability(answers.social) >= SOCIAL_THRESHOLD,
    };
    const relevantMemoryIds = new Set(
      (input.memories ?? [])
        .filter((memory) => probability(answers[`memory_${memory.id}`]) >= MEMORY_THRESHOLD)
        .map((memory) => memory.id),
    );
    console.error(
      `[planabrain] 턴 판단(${evaluator.name}, ms=${Date.now() - startedAt}) route=${signals.route}(${route?.confidence.toFixed(2) ?? "-"}) 최신정보=${signals.currentInfo} 후속=${signals.searchFollowUp} 인사=${signals.socialOnly} 기억=${relevantMemoryIds.size}/${input.memories?.length ?? 0}`,
    );
    return { signals, relevantMemoryIds };
  } catch (error) {
    checkExecution();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 턴 판단 실패(${evaluator.name}), 규칙 판단으로 대체: ${reason}`);
    return undefined;
  }
}

function memoryQuestion(content: string): SystemOneQuestion {
  return {
    type: "noul",
    instructions: `기억: "${content.slice(0, 300)}"\n이 기억이 마지막 사용자 메시지에 답하거나 대화를 이어가는 데 직접 도움이 되는가?`,
  };
}

export function parseTurnSignals(raw: unknown): TurnSignals | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (!TURN_ROUTES.includes(value.route as TurnRoute)) {
    return undefined;
  }
  const flags = ["routeConfident", "currentInfo", "searchFollowUp", "socialOnly"] as const;
  if (!flags.every((flag) => typeof value[flag] === "boolean")) {
    return undefined;
  }
  return {
    route: value.route as TurnRoute,
    routeConfident: value.routeConfident as boolean,
    currentInfo: value.currentInfo as boolean,
    searchFollowUp: value.searchFollowUp as boolean,
    socialOnly: value.socialOnly as boolean,
  };
}

function probability(answer: SystemOneAnswer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}
