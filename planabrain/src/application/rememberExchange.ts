import type { Settings } from "../config/settings.js";
import { LocalMemoryEngine } from "../memoryflow/memory-engine.js";

export async function rememberExchangeTurn(params: {
  userId: string;
  requestId?: string;
  chatId: string;
  conversationId?: string;
  userText: string;
  assistantText: string;
  wireMessages?: Array<{ role: "user" | "assistant"; content: string; }>;
  epoch?: number;
}, settings?: Settings): Promise<unknown> {
  const engine = new LocalMemoryEngine({}, settings);
  try {
    return await engine.rememberExchange(params);
  } finally {
    engine.close();
  }
}
