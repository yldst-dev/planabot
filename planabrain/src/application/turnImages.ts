import path from "node:path";
import { open, realpath } from "node:fs/promises";
import type { Settings } from "../config/settings.js";
import type { InputImage } from "../integrations/chat.js";
import { canFetchUrls, fetchWebImage } from "../integrations/webFetch.js";
import { extractImageUrls } from "../chat/imageLinks.js";
import { checkExecution } from "../runtime/execution.js";

export type ImageFile = { path: string; mimeType?: string; };

type ImageResult = { image: InputImage; } | { notice: string; };

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_NOTICE = "10MB를 넘는 이미지는 확인하지 않았습니다.";
const UNSUPPORTED_NOTICE = "지원하지 않는 형식의 이미지가 있습니다. JPEG, PNG, WebP, GIF만 볼 수 있습니다.";
const MISMATCH_NOTICE = "파일 내용이 이미지 형식과 맞지 않아 확인하지 않았습니다.";
const LINK_FAILED_NOTICE = "이미지 링크를 가져오지 못했습니다.";

export async function resolveTurnImages(params: {
  files: ImageFile[];
  notice?: string;
  text: string;
  settings: Settings;
  imageRoot?: string;
}): Promise<{ images?: InputImage[]; imageNotice?: string; }> {
  const images: InputImage[] = [];
  const notices = [params.notice?.trim()];
  for (const file of params.files.slice(0, MAX_IMAGES)) {
    collect(await readImageFile(file, params.imageRoot), images, notices);
  }
  const links = canFetchUrls(params.settings) ? extractImageUrls(params.text, MAX_IMAGES - images.length) : [];
  for (const result of await Promise.all(links.map((url) => readImageLink(params.settings, url)))) {
    collect(result, images, notices);
  }
  const imageNotice = [...new Set(notices.filter((notice): notice is string => Boolean(notice)))].join("\n");
  return { images: images.length ? images : undefined, imageNotice: imageNotice || undefined };
}

export function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function collect(result: ImageResult, images: InputImage[], notices: Array<string | undefined>): void {
  if ("notice" in result) notices.push(result.notice);
  else images.push(result.image);
}

async function readImageFile(file: ImageFile, imageRoot?: string): Promise<ImageResult> {
  const mimeType = file.mimeType?.trim() || "image/jpeg";
  let resolved: string;
  try {
    resolved = await realpath(file.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`이미지 파일 읽기 실패: ${message}`);
  }
  if (imageRoot) {
    const relative = path.relative(await realpath(imageRoot), resolved);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("이미지 파일 읽기 실패: 허용된 이미지 폴더가 아닙니다.");
    }
  }
  const handle = await open(resolved, "r");
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return { notice: TOO_LARGE_NOTICE };
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const actual = sniffImageType(bytes);
  if (!actual) return { notice: UNSUPPORTED_NOTICE };
  if (actual !== mimeType) return { notice: MISMATCH_NOTICE };
  return { image: { data: bytes.toString("base64"), mimeType } };
}

async function readImageLink(settings: Settings, url: string): Promise<ImageResult> {
  try {
    const { body } = await fetchWebImage(settings, url, MAX_IMAGE_BYTES);
    const mimeType = sniffImageType(body);
    return mimeType ? { image: { data: body.toString("base64"), mimeType } } : { notice: UNSUPPORTED_NOTICE };
  } catch (error) {
    checkExecution();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[planabrain] 이미지 링크 가져오기 실패: ${reason}`);
    return { notice: LINK_FAILED_NOTICE };
  }
}
