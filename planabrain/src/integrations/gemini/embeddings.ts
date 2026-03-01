import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

import type { Settings } from "../../config/settings.js";

export function createEmbeddings(settings: Settings): GoogleGenerativeAIEmbeddings {
  if (settings.aiProvider !== "google") {
    throw new Error(
      "Embeddings require PLANABRAIN_AI_PROVIDER=google. GeminiMock mode supports chat completions only.",
    );
  }
  if (!settings.googleApiKey) {
    throw new Error(
      "GOOGLE_API_KEY is required when PLANABRAIN_AI_PROVIDER=google",
    );
  }
  return new GoogleGenerativeAIEmbeddings({
    apiKey: settings.googleApiKey,
    modelName: settings.embeddingModel
  });
}
