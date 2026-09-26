import { checkExecution, currentExecution } from "../runtime/execution.js";

export type SystemOneConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string; };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion;

export type NoulAnswer = { type: "noul"; noul: number; };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
};

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer;

export type DecisionEvaluator = {
  name: string;
  evaluate: (state: unknown, questions: Record<string, SystemOneQuestion>) => Promise<Record<string, SystemOneAnswer>>;
};

export async function evaluateSystemOne(
  config: SystemOneConfig,
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
): Promise<Record<string, SystemOneAnswer>> {
  checkExecution();
  const signals = [AbortSignal.timeout(config.timeoutMs)];
  const executionSignal = currentExecution()?.signal;
  if (executionSignal) signals.push(executionSignal);
  const response = await fetch(`${config.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model, state, questions }),
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) {
    throw new Error(`판단 모델 호출 실패: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { answers?: unknown; };
  return readAnswers(body.answers, questions);
}

export function readAnswers(
  raw: unknown,
  questions: Record<string, SystemOneQuestion>,
): Record<string, SystemOneAnswer> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("판단 모델 응답에 answers가 없습니다.");
  }
  const record = raw as Record<string, unknown>;
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = readAnswer(record[key], question);
    if (!answer) {
      throw new Error(`판단 모델 응답 형식 오류: ${key}`);
    }
    answers[key] = answer;
  }
  return answers;
}

function readAnswer(raw: unknown, question: SystemOneQuestion): SystemOneAnswer | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (question.type === "noul") {
    return isProbability(value.noul) ? { type: "noul", noul: value.noul } : undefined;
  }
  if (typeof value.choice !== "string" || !(value.choice in question.criteria)) return undefined;
  return {
    type: "choice",
    choice: value.choice,
    confidence: isProbability(value.confidence) ? value.confidence : 0,
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
