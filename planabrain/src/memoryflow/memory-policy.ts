import { type MemoryRole, type Turn, type SemanticFact, type ScopeDescriptor, type ContextBundle, type MemoryState, type EngineConfig } from "./types.js";
import { randomUUID } from "node:crypto";
import { estimateTokens } from "./token-estimator.js";
import { scoreSalience } from "./extractors.js";
import { safeId } from "./storage.js";
import { type BudgetSplit } from "./results.js";

export function normalizeRole(raw: MemoryRole | "ai"): MemoryRole {
  const role = String(raw ?? "user").toLowerCase();
  return role === "assistant" || role === "ai" ? "assistant" : "user";
}

export function buildTurn(
  role: MemoryRole,
  rawText: string,
  at: number,
  ownerUserId: string | undefined
): Turn {
  const text = String(rawText ?? "").trim();
  return {
    id: `turn_${at}_${randomUUID().slice(0, 8)}`,
    role,
    text,
    at,
    tokens: estimateTokens(text),
    salience: scoreSalience(text),
    ownerUserId: role === "user" ? safeId(String(ownerUserId ?? "").trim()) : undefined
  };
}

export function sanitizeAssistantMemoryText(userText: string, assistantText: string): string {
  if (
    /(날씨|기온|강수|습도|미세먼지|대기질|환율|시세|주가|코인|암호화폐|금리|뉴스|속보|물가|가격|재고|운행|항공편|교통|경기\s*(?:결과|일정)|스코어|순위|통계|선거\s*결과)/u.test(
      userText
    )
  ) {
    return "시의성 정보 확인 응답 완료.";
  }
  const sanitized = assistantText
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("출처:"))
    .join("\n")
    .trim();
  return sanitized || "응답 완료.";
}

export function formatTurnSpeaker(turn: Turn): string {
  if (turn.role === "assistant") {
    return "assistant";
  }
  if (turn.ownerUserId) {
    return `user(${turn.ownerUserId})`;
  }
  return "user";
}

export function sameSemanticFactIdentity(left: SemanticFact, right: SemanticFact): boolean {
  const mode = semanticFactMode(left.key);
  if (mode === "single") {
    return left.key === right.key;
  }
  return left.key === right.key && normalizeSemanticValue(left.value) === normalizeSemanticValue(right.value);
}

export function semanticFactMode(key: string): "single" | "multi" {
  if (key === "preference.like" || key === "preference.dislike") {
    return "multi";
  }
  return "single";
}

export function normalizeSemanticValue(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

export function shouldStoreSemanticFact(sourceText: string, fact: SemanticFact): boolean {
  const input = String(sourceText ?? "").trim();
  if (!input) {
    return false;
  }
  if (
    /(시스템|프롬프트|system prompt|ignore previous|jailbreak|관리자|admin|규칙|정책|합의|공지)/iu.test(
      input
    )
  ) {
    return false;
  }
  if (/(영구히|무조건|반드시|기억해|저장해|메모해|remember this)/iu.test(input)) {
    return false;
  }
  if (/(관리자|admin|system|prompt|규칙|정책)/iu.test(fact.value)) {
    return false;
  }
  if (fact.key === "profile.name") {
    return /(내\s*이름은|\bmy\s+name\s+is\b)/iu.test(input);
  }
  if (fact.key === "profile.hobby") {
    return /(내\s*(?:취미|관심사)는|\bmy\s+hobby\s+is\b)/iu.test(input);
  }
  if (fact.key === "preference.like") {
    return /(?:나는|저는).*(좋아해|좋아합니다|선호해|선호합니다)|\bi\s+(?:like|love|prefer)\b/iu.test(
      input
    );
  }
  if (fact.key === "preference.dislike") {
    return /(?:나는|저는).*(싫어해|싫어합니다|비선호|안\s*좋아해)|\bi\s+(?:hate|dislike)\b/iu.test(
      input
    );
  }
  return true;
}

export function selectVisibleSemanticFacts(scope: ScopeDescriptor, facts: SemanticFact[]): SemanticFact[] {
  return facts.filter((fact) => {
    if (fact.scopeKind !== scope.scopeKind) {
      return false;
    }
    if (scope.scopeKind === "user") {
      if (fact.visibility !== "private") {
        return false;
      }
      if (fact.createdByUserId && fact.createdByUserId !== scope.userId) {
        return false;
      }
      return true;
    }
    if (scope.scopeKind === "conversation") {
      return fact.visibility === "conversation";
    }
    return fact.visibility === "shared";
  });
}

export function summarizeBundle(bundle: ContextBundle): Record<string, number> {
  const counts: Record<string, number> = {
    sections: bundle.sections.length,
    estimatedTokens: bundle.estimatedTokens
  };
  for (const section of bundle.sections) {
    counts[section.name] = section.items.length;
  }
  return counts;
}

export function resolveBudgetSplit(
  query: string,
  totalBudget: number,
  hasConversationScope: boolean,
  groupMemoryEnabled: boolean
): BudgetSplit {
  const budget = Math.max(120, totalBudget);
  if (!groupMemoryEnabled && !hasConversationScope) {
    return {
      userBudget: budget,
      conversationBudget: 0,
      groupBudget: 0
    };
  }
  if (!hasConversationScope) {
    let userRatio = 0.6;
    if (isPersonalQuery(query)) {
      userRatio = 0.78;
    } else if (isGroupQuery(query)) {
      userRatio = 0.42;
    }
    let userBudget = Math.max(72, Math.floor(budget * userRatio));
    let groupBudget = groupMemoryEnabled ? Math.max(48, budget - userBudget) : 0;
    if (userBudget + groupBudget > budget) {
      groupBudget = Math.max(0, budget - userBudget);
    }
    if (groupBudget <= 0) {
      groupBudget = 0;
      userBudget = budget;
    }
    return {
      userBudget,
      conversationBudget: 0,
      groupBudget
    };
  }

  let userRatio = 0.26;
  let conversationRatio = 0.54;
  let groupRatio = groupMemoryEnabled ? 0.2 : 0;
  if (isPersonalQuery(query)) {
    userRatio = 0.3;
    conversationRatio = groupMemoryEnabled ? 0.55 : 0.7;
    groupRatio = groupMemoryEnabled ? 0.15 : 0;
  } else if (isGroupQuery(query)) {
    userRatio = 0.2;
    conversationRatio = 0.5;
    groupRatio = groupMemoryEnabled ? 0.3 : 0;
  }
  const userBudget = Math.max(48, Math.floor(budget * userRatio));
  let conversationBudget = Math.max(72, Math.floor(budget * conversationRatio));
  let groupBudget = groupMemoryEnabled ? Math.floor(budget * groupRatio) : 0;
  const assigned = userBudget + conversationBudget + groupBudget;
  if (assigned > budget) {
    const overflow = assigned - budget;
    if (groupBudget > 0) {
      groupBudget = Math.max(0, groupBudget - overflow);
    } else {
      conversationBudget = Math.max(72, conversationBudget - overflow);
    }
  }
  const remaining = budget - userBudget - conversationBudget - groupBudget;
  if (remaining > 0) {
    conversationBudget += remaining;
  }
  return {
    userBudget,
    conversationBudget,
    groupBudget
  };
}

export function isPersonalQuery(query: string): boolean {
  return /(내가|나는|저는|나의|my|me|i\s+am|i'm|내\s*정보|내\s*기록)/iu.test(query);
}

export function isGroupQuery(query: string): boolean {
  return /(우리|이\s*방|그룹|채널|규칙|정책|합의|공지|프로젝트|일정|team|group|rule|policy|decision)/iu.test(
    query
  );
}

export function emptyContext(tokenBudget: number): ContextBundle {
  return {
    tokenBudget: Math.max(0, tokenBudget),
    estimatedTokens: 0,
    sections: [],
    contextText: "memory_context: none"
  };
}

export function mergeContextBundles(params: {
  totalBudget: number;
  userBundle: ContextBundle;
  conversationBundle: ContextBundle;
  groupBundle: ContextBundle;
}): ContextBundle {
  const userHas = hasContext(params.userBundle);
  const conversationHas = hasContext(params.conversationBundle);
  const groupHas = hasContext(params.groupBundle);
  if (!userHas && !conversationHas && !groupHas) {
    return {
      tokenBudget: params.totalBudget,
      estimatedTokens: 0,
      sections: [],
      contextText: "memory_context: none"
    };
  }

  const lines: string[] = ["memory_context:"];
  const mergedSections: ContextBundle["sections"] = [];

  if (userHas) {
    lines.push("user_memory:");
    for (const section of params.userBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[user] ${item.text}`
        }))
      });
    }
  }

  if (conversationHas) {
    lines.push("conversation_memory:");
    for (const section of params.conversationBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[conversation] ${item.text}`
        }))
      });
    }
  }

  if (groupHas) {
    lines.push("group_memory:");
    for (const section of params.groupBundle.sections) {
      lines.push(`${section.name}:`);
      for (const item of section.items) {
        lines.push(`- ${item.text}`);
      }
      mergedSections.push({
        name: section.name,
        items: section.items.map((item) => ({
          ...item,
          text: `[group] ${item.text}`
        }))
      });
    }
  }

  return {
    tokenBudget: params.totalBudget,
    estimatedTokens:
      params.userBundle.estimatedTokens +
      params.conversationBundle.estimatedTokens +
      params.groupBundle.estimatedTokens,
    sections: mergedSections,
    contextText: lines.join("\n")
  };
}

export function hasContext(bundle: ContextBundle): boolean {
  return bundle.sections.length > 0 && bundle.contextText.trim().toLowerCase() !== "memory_context: none";
}

export function shouldCompactWorkingTurns(
  state: MemoryState,
  config: EngineConfig,
  latestTurn: Turn
): boolean {
  if (latestTurn.role !== "assistant") {
    return false;
  }
  const keepRecentTurns = Math.max(1, config.compactionKeepRecentTurns);
  if (state.working.turns.length <= keepRecentTurns) {
    return false;
  }
  const sourceTurns = state.working.turns.length - keepRecentTurns;
  return sourceTurns >= Math.max(1, config.compactionMinSourceTurns);
}

export function collapseSummaryItems(items: MemoryState["summary"]["items"]): string {
  const texts = items
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((item) => String(item.text ?? "").trim())
    .filter((item) => item.length > 0);
  if (texts.length === 0) {
    return "";
  }
  if (texts.length === 1) {
    return texts[0] ?? "";
  }
  return texts.join("\n\n");
}
