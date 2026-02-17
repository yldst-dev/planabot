const DIMENSION = 256;

export function embedText(text: string): number[] {
  const normalized = normalize(text);
  if (!normalized) {
    return new Array(DIMENSION).fill(0);
  }

  const chars = Array.from(normalized);
  const vector = new Array(DIMENSION).fill(0);

  if (chars.length < 3) {
    for (let i = 0; i < chars.length; i += 1) {
      const h = hashString(chars[i] ?? "");
      const index = h % DIMENSION;
      vector[index] += 1;
    }
    return normalizeVector(vector);
  }

  for (let i = 0; i <= chars.length - 3; i += 1) {
    const gram = `${chars[i] ?? ""}${chars[i + 1] ?? ""}${chars[i + 2] ?? ""}`;
    const h1 = hashString(gram);
    const h2 = hashString(`${gram}#`);
    const indexA = h1 % DIMENSION;
    const indexB = h2 % DIMENSION;
    vector[indexA] += 1;
    vector[indexB] -= 0.5;
  }

  return normalizeVector(vector);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  const denom = Math.sqrt(a2) * Math.sqrt(b2);
  if (!denom) {
    return 0;
  }
  return dot / denom;
}

function normalizeVector(values: number[]): number[] {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!norm) {
    return values;
  }
  return values.map((value) => value / norm);
}

function normalize(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
