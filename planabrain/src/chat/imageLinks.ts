import { extractUrls } from "../integrations/webFetch.js";

const IMAGE_PATH_PATTERN = /\.(?:jpe?g|png|webp|gif)$/iu;

export function isImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && IMAGE_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

export function extractImageUrls(text: string, max: number): string[] {
  if (max <= 0) {
    return [];
  }
  return extractUrls(text, 10).filter(isImageUrl).slice(0, max);
}
