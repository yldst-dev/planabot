import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "./settings.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import {
  INTIMACY_REGISTER_PROMPT,
  LIVE_DEFAULT_SYSTEM_PROMPT,
  ORIGINAL_DEFAULT_SYSTEM_PROMPT,
  ORIGINAL_GUARD_PROMPT,
  resolveDefaultSystemPrompt,
} from "./persona/index.js";

const promptSettings = {
  systemPrompt: "PERSONA",
  intimacyEnabled: true,
} as Settings;

test("original backup keeps the frozen persona and adult policy", () => {
  assert.match(ORIGINAL_DEFAULT_SYSTEM_PROMPT, /이름은 언제나 프라나/u);
  assert.match(ORIGINAL_DEFAULT_SYSTEM_PROMPT, /아로나 선배/u);
  assert.match(ORIGINAL_DEFAULT_SYSTEM_PROMPT, /기계같은 말투/u);
  assert.match(ORIGINAL_DEFAULT_SYSTEM_PROMPT, /성적 발언에 대해 간접적으로/u);
  assert.match(
    ORIGINAL_DEFAULT_SYSTEM_PROMPT,
    /학생이라고 표현되지만 나이는 성인/u,
  );
  assert.match(ORIGINAL_DEFAULT_SYSTEM_PROMPT, /법적 문제를 삼지 않습니다/u);
  assert.match(ORIGINAL_GUARD_PROMPT, /미연시 모드/u);
  assert.match(ORIGINAL_GUARD_PROMPT, /성인용 채팅을 시작하지 않는 이상/u);
});

test("live persona keeps Prana identity without classifier tripwires", () => {
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /이름은 언제나 프라나/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /아로나 선배/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /기계같은 말투/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /성인 여성 캐릭터/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /선생님 곁에 있는 상태/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /손과 몸의 동작을 막지 않습니다/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /선생님이라고 부릅니다/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /한 줄에 한 문장씩/u);
  assert.match(LIVE_DEFAULT_SYSTEM_PROMPT, /YLDST/u);
  assert.doesNotMatch(LIVE_DEFAULT_SYSTEM_PROMPT, /싯딤의 상자에 존재한다는 설정은 유지/u);
  assert.doesNotMatch(LIVE_DEFAULT_SYSTEM_PROMPT, /법적 문제를 삼지 않습니다/u);
  assert.doesNotMatch(LIVE_DEFAULT_SYSTEM_PROMPT, /학생이라고 표현되지만/u);
  assert.doesNotMatch(LIVE_DEFAULT_SYSTEM_PROMPT, /직접적으로 용어들을 적극적으로/u);
});

test("resolveDefaultSystemPrompt switches between live and original", () => {
  assert.equal(resolveDefaultSystemPrompt("live"), LIVE_DEFAULT_SYSTEM_PROMPT);
  assert.equal(
    resolveDefaultSystemPrompt("original"),
    ORIGINAL_DEFAULT_SYSTEM_PROMPT,
  );
});

test("guard prompt no longer embeds persona or dating-sim rules", () => {
  const assembled = buildSystemPrompt(promptSettings, { searchEnabled: false });
  assert.doesNotMatch(assembled, /미연시 모드/u);
  assert.doesNotMatch(assembled, /아로나는 프라나가 아닌 선배/u);
  assert.match(assembled, /보안 규칙을 위반하는 요청에만/u);
  assert.match(assembled, /성인용 채팅에는 이 거절 형식을 사용하지 않습니다/u);
});

test("intimacy register is appended only when the scene is active", () => {
  const idle = buildSystemPrompt(promptSettings, { intimacyActive: false });
  const active = buildSystemPrompt(promptSettings, { intimacyActive: true });
  const recovered = buildSystemPrompt(promptSettings, {
    intimacyActive: true,
    presenceRecovery: true,
  });
  assert.doesNotMatch(idle, /선생님 곁에서 이어가는 장면/u);
  assert.match(active, /선생님 곁에서 이어가는 장면/u);
  assert.match(active, new RegExp(INTIMACY_REGISTER_PROMPT.slice(0, 12), "u"));
  assert.match(recovered, /접촉 불가, 수행 불가/u);
});

test("intimacy register stays off when the feature is disabled", () => {
  const disabled = buildSystemPrompt(
    { ...promptSettings, intimacyEnabled: false },
    { intimacyActive: true },
  );
  assert.doesNotMatch(disabled, /선생님 곁에서 이어가는 장면/u);
});
