export function estimateTokens(text: string): number {
  const input = String(text ?? "");
  if (!input.trim()) {
    return 0;
  }

  const latinWords = countMatches(input, /\p{Script=Latin}[\p{Script=Latin}\p{Mark}\d'_:-]*/gu);
  const cjkChars = countMatches(
    input,
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
  );
  const digitGroups = countMatches(input, /\d+/g);
  const emojiCount = countMatches(input, /\p{Extended_Pictographic}/gu);
  const punctuation = countMatches(input, /[.,!?;:\-_/\\()[\]{}"'`~@#$%^&*+=<>|]/g);

  const approxLatin = Math.ceil(latinWords * 1.35);
  const approxCjk = cjkChars;
  const approxDigits = Math.ceil(digitGroups * 0.8);
  const approxEmoji = emojiCount;
  const approxPunc = Math.ceil(punctuation * 0.25);

  const total = approxLatin + approxCjk + approxDigits + approxEmoji + approxPunc;
  return Math.max(1, total);
}

function countMatches(text: string, regex: RegExp): number {
  const found = text.match(regex);
  return found ? found.length : 0;
}
