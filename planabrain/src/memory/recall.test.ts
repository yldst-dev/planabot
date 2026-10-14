import assert from "node:assert/strict";
import test from "node:test";

import { fallbackRelevant } from "./recall.js";
import type { MemoryRecord } from "./types.js";

function memory(id: number, content: string): MemoryRecord {
  return { id, subjectUserId: "u1", chatId: "chat_u1", direct: true, kind: "fact", content, importance: 0.5, createdAt: 1, updatedAt: 1, lastRecalledAt: null };
}

test("the shared subject words of memories do not make them look related", () => {
  const memories = [memory(1, "사용자는 고양이를 키운다"), memory(2, "사용자는 부산에 산다"), memory(3, "사용자의 생일은 3월이다")];
  assert.deepEqual(fallbackRelevant(memories, "자는 중이야"), []);
  assert.deepEqual(fallbackRelevant(memories, "사용법 알려줘"), []);
  assert.deepEqual(fallbackRelevant(memories, "고양이 밥 뭐 주지?").map((item) => item.id), [1]);
});
