import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Settings } from "../config/settings.js";
import { createChatModel } from "../integrations/gemini/chat.js";
import { createGoogleSearchTool } from "../integrations/googleSearch/retrievalTool.js";
import { appendUserMemory, loadUserMemory } from "../memory/userMemoryStore.js";

export async function answerWithWebSearch(params: {
  question: string;
  settings: Settings;
  userId?: string;
}): Promise<string> {
  const tool = createGoogleSearchTool();
  const llm = createChatModel(params.settings).bindTools([tool]);

  const userId = params.userId ?? "default";
  const history =
    params.settings.memoryEnabled && params.settings.memoryMaxMessages > 0
      ? await loadUserMemory({
          memoryDir: params.settings.memoryDir,
          userId,
          maxMessages: params.settings.memoryMaxMessages
        })
      : [];

  const result = await llm.invoke([
    new SystemMessage(params.settings.systemPrompt),
    ...history.map((m) =>
      m.role === "ai" ? new AIMessage(m.content) : new HumanMessage(m.content)
    ),
    new HumanMessage(params.question)
  ]);

  const answer = String(result.content);

  if (params.settings.memoryEnabled && params.settings.memoryMaxMessages > 0) {
    await appendUserMemory({
      memoryDir: params.settings.memoryDir,
      userId,
      maxMessages: params.settings.memoryMaxMessages,
      messages: [
        { role: "human", content: params.question, at: Date.now() },
        { role: "ai", content: answer, at: Date.now() }
      ]
    });
  }

  return answer;
}
