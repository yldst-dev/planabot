import path from "node:path";
import { open, realpath } from "node:fs/promises";
import type { Settings } from "../config/settings.js";
import type { InputImage } from "../integrations/chat.js";
import { canFetchUrls } from "../integrations/webFetch.js";
import { MAX_IMAGE_BYTES, MAX_TURN_IMAGES, extractImageUrls, loadLinkedImage, sniffImageType } from "../chat/imageLinks.js";

export type ImageFile = { path: string; mimeType?: string; };

type ImageResult = { image: InputImage; } | { notice: string; };

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
  for (const file of params.files.slice(0, MAX_TURN_IMAGES)) {
    collect(await readImageFile(file, params.imageRoot), images, notices);
  }
  const links = canFetchUrls(params.settings) ? extractImageUrls(params.text, MAX_TURN_IMAGES - images.length) : [];
  for (const result of await Promise.all(links.map((url) => readImageLink(params.settings, url)))) {
    collect(result, images, notices);
  }
  const imageNotice = [...new Set(notices.filter((notice): notice is string => Boolean(notice)))].join("\n");
  return { images: images.length ? images : undefined, imageNotice: imageNotice || undefined };
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
  const result = await loadLinkedImage(settings, url);
  if ("image" in result) return result;
  return { notice: result.failure === "unsupported" ? UNSUPPORTED_NOTICE : LINK_FAILED_NOTICE };
}
