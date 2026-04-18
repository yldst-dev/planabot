import type { Settings } from "../../config/settings.js";
import type { InputImage } from "../../integrations/gemini/chat.js";
import { answerWithWebSearch } from "../../chat/webSearchAnswer.js";

export async function runAskCommand(args: string[], settings: Settings): Promise<void> {
  let question = args.join(" ").trim();
  if (!question) {
    const questionFile = process.env.PLANABRAIN_QUESTION_FILE;
    if (questionFile) {
      try {
        const { readFile } = await import("node:fs/promises");
        question = (await readFile(questionFile, "utf8")).trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PLANABRAIN_QUESTION_FILE 읽기 실패: ${message}`);
      }
    }
  }
  if (!question) {
    throw new Error("Usage: planabrain ask <question>");
  }

  const userId = process.env.PLANABRAIN_USER_ID ?? "cli";
  const images = await resolveImagesFromEnv();
  const answer = await answerWithWebSearch({ question, settings, userId, images });
  process.stdout.write(`${answer}\n`);
}

async function resolveImagesFromEnv(): Promise<InputImage[] | undefined> {
  const imageFile = process.env.PLANABRAIN_IMAGE_FILE?.trim();
  if (!imageFile) {
    return undefined;
  }
  const mimeType = process.env.PLANABRAIN_IMAGE_MIME_TYPE?.trim() || "image/jpeg";
  try {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(imageFile);
    return [{ data: bytes.toString("base64"), mimeType }];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PLANABRAIN_IMAGE_FILE 읽기 실패: ${message}`);
  }
}
