

export const DEFAULT_CHAT_TEMPERATURE = 1.0;

export const DEFAULT_CHAT_TOP_P = 0.7;

export function requiresGlmReasoning(model: string): boolean {
  return /(?:^|\/)glm-5\.3-flash(?::[^/]+)?$/iu.test(model);
}
