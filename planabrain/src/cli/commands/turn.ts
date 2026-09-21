import { parseTurnPrepareInput, prepareTurn } from "../../application/prepareTurn.js";

export async function runTurnPrepareCommand(): Promise<void> {
  const input = parseTurnPrepareInput(await readStdin());
  input.requestId ??= process.env.PLANABRAIN_REQUEST_ID;
  const deadlineMs = Number(process.env.PLANABRAIN_DEADLINE_MS);
  input.deadlineMs ??= Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : undefined;
  const output = await prepareTurn(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
