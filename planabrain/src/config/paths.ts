import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PLANABRAIN_DATA_DIR?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(process.cwd(), explicit);
  }
  return path.resolve(PACKAGE_ROOT, "..");
}

export function resolveDataPath(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = raw.trim();
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(resolveDataRoot(env), trimmed);
}
