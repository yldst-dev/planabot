import {
  ORIGINAL_DEFAULT_SYSTEM_PROMPT,
  ORIGINAL_GUARD_PROMPT,
} from "./originalBackup.js";
import { LIVE_DEFAULT_SYSTEM_PROMPT } from "./pranaPersona.js";
import {
  INTIMACY_REGISTER_PROMPT,
  INTIMACY_UNAVAILABLE_REPLY,
  PRESENCE_RECOVERY_PROMPT,
} from "./intimacyPolicy.js";

export {
  ORIGINAL_DEFAULT_SYSTEM_PROMPT,
  ORIGINAL_GUARD_PROMPT,
  LIVE_DEFAULT_SYSTEM_PROMPT,
  INTIMACY_REGISTER_PROMPT,
  INTIMACY_UNAVAILABLE_REPLY,
  PRESENCE_RECOVERY_PROMPT,
};

export function resolveDefaultSystemPrompt(
  profile: "live" | "original",
): string {
  return profile === "original"
    ? ORIGINAL_DEFAULT_SYSTEM_PROMPT
    : LIVE_DEFAULT_SYSTEM_PROMPT;
}
