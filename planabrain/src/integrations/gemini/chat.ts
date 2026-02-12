import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type { Settings } from "../../config/settings.js";

export function createChatModel(settings: Settings): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    apiKey: settings.googleApiKey,
    model: settings.chatModel,
    maxOutputTokens: settings.chatMaxOutputTokens,
    topP: 0.7,
    thinkingConfig: {
      thinkingLevel: "LOW",
    },
  });
}
