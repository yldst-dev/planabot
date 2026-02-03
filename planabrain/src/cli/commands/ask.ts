import type { Settings } from "../../config/settings.js";
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
  const answer = await answerWithWebSearch({ question, settings, userId });
  process.stdout.write(`${answer}\n`);
}
