import { type Settings } from "../config/settings.js";

export function resolveAuxSettings(settings: Settings): Settings {
  return { ...settings, chatModel: settings.auxModel ?? settings.chatModel, chatThinkingMode: "off", codexFast: false };
}
