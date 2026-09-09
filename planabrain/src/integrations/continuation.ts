

export function shouldContinueChat(
  finishReason: string | undefined,
  content: string,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  return isLengthLimitedFinishReason(finishReason) || looksAbruptlyTruncated(trimmed);
}

export function isLengthLimitedFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) {
    return false;
  }
  const normalized = finishReason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "length" ||
    normalized === "token_limit" ||
    normalized === "output_token_limit"
  );
}

export function looksAbruptlyTruncated(content: string): boolean {
  if (content.length < 220) {
    return false;
  }
  if (hasUnbalancedPairs(content)) {
    return true;
  }
  if (/[.!?…][\])}"'”’]*$/.test(content)) {
    return false;
  }
  if (/https?:\/\/\S+$/.test(content)) {
    return false;
  }
  const tail = content.slice(-120);
  if (/[:;,]\s*$/.test(tail)) {
    return true;
  }
  if (/[가-힣A-Za-z0-9]$/.test(content)) {
    return /(?:의|은|는|이|가|을|를|와|과|로|에|에서|에게|부터|까지|이며|또는|그리고|및|후|중|예정|가능|경우|관련)$/.test(
      tail,
    );
  }
  return false;
}

export function hasUnbalancedPairs(content: string): boolean {
  const boldMatches = content.match(/\*\*/g)?.length ?? 0;
  if (boldMatches % 2 !== 0) {
    return true;
  }
  const openParens = (content.match(/\(/g)?.length ?? 0) - (content.match(/\)/g)?.length ?? 0);
  const openBrackets = (content.match(/\[/g)?.length ?? 0) - (content.match(/\]/g)?.length ?? 0);
  return openParens > 0 || openBrackets > 0;
}

export function mergeContinuationContent(existing: string, next: string): string {
  const previous = existing.trimEnd();
  const continuation = next.trim();
  if (!previous) {
    return continuation;
  }
  if (!continuation) {
    return previous;
  }
  if (previous.includes(continuation)) {
    return previous;
  }
  if (continuation.startsWith(previous)) {
    return continuation;
  }
  const overlap = findSuffixPrefixOverlap(previous, continuation);
  if (overlap > 0) {
    return `${previous}${continuation.slice(overlap)}`.trim();
  }
  if (
    /[가-힣A-Za-z0-9]$/.test(previous) &&
    /^[가-힣A-Za-z0-9]/.test(continuation)
  ) {
    return `${previous}${continuation}`;
  }
  return `${previous}\n\n${continuation}`.trim();
}

export function findSuffixPrefixOverlap(existing: string, next: string): number {
  const limit = Math.min(existing.length, next.length, 400);
  for (let size = limit; size >= 20; size -= 1) {
    if (existing.slice(-size) === next.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

export function normalizeContinuationArtifacts(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd());
  const sourceIndexes = lines
    .map((line, index) => (line.trimStart().startsWith("출처:") ? index : -1))
    .filter((index) => index >= 0);
  if (sourceIndexes.length <= 1) {
    return lines.join("\n").trim();
  }
  const keepIndex = sourceIndexes[sourceIndexes.length - 1] ?? -1;
  return lines
    .filter((_, index) => !sourceIndexes.includes(index) || index === keepIndex)
    .join("\n")
    .trim();
}
