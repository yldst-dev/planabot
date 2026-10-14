import type { Settings } from "../config/settings.js";
import type { InputImage } from "../integrations/chat.js";
import { extractUrls, fetchWebImage } from "../integrations/webFetch.js";
import { checkExecution } from "../runtime/execution.js";

export const MAX_TURN_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ANTHROPIC_MAX_IMAGE_BYTES = 3_932_160;

const IMAGE_PATH_PATTERN = /\.(?:jpe?g|png|webp|gif)$/iu;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export type LinkedImage = { image: InputImage; } | { failure: "unsupported" | "too_large" | "failed"; };

export function imageSizeLimit(settings: Pick<Settings, "aiProvider">): { bytes: number; label: string; } {
  return settings.aiProvider === "anthropic"
    ? { bytes: ANTHROPIC_MAX_IMAGE_BYTES, label: "3.75MB" }
    : { bytes: MAX_IMAGE_BYTES, label: "10MB" };
}

export function isImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && IMAGE_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

export function youtubeThumbnail(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const id = host === "youtu.be"
    ? segments[0]
    : YOUTUBE_HOSTS.has(host)
      ? segments[0] === "watch" ? url.searchParams.get("v") ?? undefined
        : ["shorts", "live", "embed"].includes(segments[0] ?? "") ? segments[1] : undefined
      : undefined;
  return id && YOUTUBE_ID_PATTERN.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

export function extractImageUrls(text: string, max: number): string[] {
  if (max <= 0) {
    return [];
  }
  return extractUrls(text, 10).filter(isImageUrl).slice(0, max);
}

export function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function loadLinkedImage(settings: Settings, url: string): Promise<LinkedImage> {
  try {
    const { body } = await fetchWebImage(settings, url, imageSizeLimit(settings).bytes);
    const mimeType = sniffImageType(body);
    return mimeType ? { image: { data: body.toString("base64"), mimeType } } : { failure: "unsupported" };
  } catch (error) {
    checkExecution();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 이미지 링크 가져오기 실패: ${reason}`);
    return { failure: /크기가 제한을 초과/u.test(reason) ? "too_large" : "failed" };
  }
}
