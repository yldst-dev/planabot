const GENERIC_FAILURE_REPLY =
  "오류.\n선생님.\n응답 생성에 실패했습니다.\n잠시 후 다시 시도해 주세요.";

const SELF_NAME_PATTERN =
  /(저는|저도|제가|저를|제\s*이름은|내\s*이름은|나는|내가|본인은)(\s*)(아로나|A\.?\s*R\.?\s*O\.?\s*N\.?\s*A)(?=\s*(?:입니다|입니다만|이에요|예요|에요|이야|야|였|이었|라고|라는))/gi;

export function correctSelfName(text: string): string {
  return text.replace(
    SELF_NAME_PATTERN,
    (_match, subject: string, space: string) => `${subject}${space}프라나`,
  );
}

export function sanitizeAssistantOutput(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return normalized;
  }
  return correctSelfName(resolveAssistantOutput(normalized));
}

function resolveAssistantOutput(normalized: string): string {
  const suspicious = isReasoningLeak(normalized);
  if (!suspicious) {
    return normalized;
  }
  const strippedByParagraph = stripSuspiciousLeadingParagraphs(normalized);
  if (strippedByParagraph && strippedByParagraph !== normalized) {
    return strippedByParagraph;
  }
  const strippedByLine = stripSuspiciousLeadingLines(normalized);
  if (strippedByLine && strippedByLine !== normalized) {
    return strippedByLine;
  }
  const recovered = recoverFromTeacherAnchor(normalized);
  if (recovered) {
    return recovered;
  }
  return GENERIC_FAILURE_REPLY;
}

function stripSuspiciousLeadingParagraphs(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  let index = 0;
  while (
    index < paragraphs.length - 1 &&
    isSuspiciousParagraph(paragraphs[index] ?? "")
  ) {
    index += 1;
  }
  return paragraphs.slice(index).join("\n\n").trim();
}

function stripSuspiciousLeadingLines(text: string): string {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length - 1 && isSuspiciousLine(lines[index] ?? "")) {
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

function recoverFromTeacherAnchor(text: string): string {
  const teacherIndex = text.indexOf("선생님");
  if (teacherIndex > 0) {
    const recovered = text.slice(teacherIndex).trim();
    if (recovered && !isReasoningLeak(recovered)) {
      return recovered;
    }
  }
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      continue;
    }
    if (hasHangul(line) && !isSuspiciousLine(line)) {
      return lines.slice(index).join("\n").trim();
    }
  }
  return "";
}

function isReasoningLeak(text: string): boolean {
  const sample = text.slice(0, 800);
  return (
    /wait,\s*the user is/i.test(sample) ||
    /wait,\s*the prompt says/i.test(sample) ||
    /the previous assistant response/i.test(sample) ||
    /the prompt says/i.test(sample) ||
    /dating sim mode/i.test(sample) ||
    /i should maintain/i.test(sample) ||
    /i should\b/i.test(sample) ||
    /internal (reasoning|thought|monologue)/i.test(sample) ||
    /system prompt/i.test(sample) ||
    /hidden chain of thought/i.test(sample) ||
    /roleplay tone/i.test(sample) ||
    /미연시 모드/i.test(sample) ||
    /저를 만드신 분/i.test(sample)
  );
}

function isSuspiciousParagraph(value: string): boolean {
  const paragraph = value.trim();
  if (!paragraph) {
    return false;
  }
  return (
    isSuspiciousLine(paragraph) ||
    (/^(?:[-*]\s*|>\s*)/.test(paragraph) && isReasoningLeak(paragraph)) ||
    (!hasHangul(paragraph) &&
      /(wait|previous assistant|dating sim mode|i should|system prompt|roleplay)/i.test(
        paragraph,
      ))
  );
}

function isSuspiciousLine(value: string): boolean {
  const line = value.trim();
  if (!line) {
    return false;
  }
  return (
    /^(?:[-*]\s*|>\s*)?\*?\s*wait,\s*the user is/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*wait,\s*the prompt says/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*the previous assistant response/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*the prompt says/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*i should\b/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*dating sim mode/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*system prompt/i.test(line) ||
    /^(?:[-*]\s*|>\s*)?\*?\s*internal reasoning/i.test(line)
  );
}

function hasHangul(value: string): boolean {
  return /[가-힣]/.test(value);
}
