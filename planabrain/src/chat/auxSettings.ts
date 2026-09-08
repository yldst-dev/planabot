import { defaultChatModel, type Settings } from "../config/settings.js";
import { providerHasCredentials } from "../integrations/chat.js";

export function resolveAuxSettings(settings: Settings): Settings {
  const provider = settings.auxProvider ?? settings.aiProvider;
  if (provider !== settings.aiProvider && !providerHasCredentials(settings, provider)) {
    return { ...settings, chatThinkingMode: "off" };
  }
  const chatModel =
    settings.auxModel ??
    (provider === settings.aiProvider ? settings.chatModel : defaultChatModel(provider));
  return { ...settings, aiProvider: provider, chatModel, chatThinkingMode: "off" };
}
