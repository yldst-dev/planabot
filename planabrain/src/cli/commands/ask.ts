import type { Settings } from "../../config/settings.js";
import { answerWithWebSearch } from "../../chat/webSearchAnswer.js";

export async function runAskCommand(args: string[], settings: Settings): Promise<void> {
  const question = args.join(" ").trim();
  if (!question) {
    throw new Error("Usage: planabrain ask <question>");
  }

  const userId = process.env.PLANABRAIN_USER_ID ?? "cli";
  const answer = await answerWithWebSearch({ question, settings, userId });
  process.stdout.write(`${answer}\n`);
}
