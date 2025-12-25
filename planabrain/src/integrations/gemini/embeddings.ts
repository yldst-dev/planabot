import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

import type { Settings } from "../../config/settings.js";

export function createEmbeddings(settings: Settings): GoogleGenerativeAIEmbeddings {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: settings.googleApiKey,
    modelName: settings.embeddingModel
  });
}
