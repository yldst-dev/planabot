import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

import type { Settings } from "../config/settings.js";

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (compatible; PlanabotWebFetch/1.0)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xhtml+xml",
  "text/html",
  "text/markdown",
  "text/plain",
]);
const BLOCKED_HOST_SUFFIXES = [
  ".home",
  ".internal",
  ".lan",
  ".local",
  ".localhost",
];
const BLOCKED_ADDRESSES = createBlockedAddresses();

export type WebFetchResult = {
  sourceUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
};

type RawPage = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  const cleaned = matches.map((url) => url.replace(/[.,;:!?)\]}'"]+$/, ""));
  return Array.from(new Set(cleaned)).slice(0, 3);
}

export function canFetchUrls(settings: Settings): boolean {
  return settings.webFetchEnabled;
}

export async function fetchWebPage(
  settings: Settings,
  rawUrl: string,
): Promise<WebFetchResult> {
  const sourceUrl = parseWebFetchUrl(rawUrl).toString();
  let currentUrl = sourceUrl;
  const visited = new Set<string>();
  const deadline = Date.now() + settings.webFetchTimeoutMs;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (visited.has(currentUrl)) {
      throw new Error("웹페이지 리디렉션이 반복됩니다.");
    }
    visited.add(currentUrl);

    const url = parseWebFetchUrl(currentUrl);
    const address = await resolvePublicAddress(
      url.hostname,
      remainingTime(deadline),
    );
    const response = await requestPinnedPage({
      url,
      address,
      timeoutMs: remainingTime(deadline),
      maxBytes: settings.webFetchMaxBytes,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = readHeader(response.headers.location);
      if (!location) {
        throw new Error("웹페이지 리디렉션 주소가 없습니다.");
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("웹페이지 리디렉션 횟수를 초과했습니다.");
      }
      const nextUrl = parseWebFetchUrl(new URL(location, url).toString());
      if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
        throw new Error("보안 연결에서 비보안 연결로 이동할 수 없습니다.");
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`웹페이지가 HTTP ${response.status} 상태를 반환했습니다.`);
    }

    const contentType = normalizeContentType(response.headers["content-type"]);
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error("지원하지 않는 웹페이지 형식입니다.");
    }
    const charset = readCharset(response.headers["content-type"]);
    const decoded = decodeBody(response.body, charset);
    const extracted = extractReadableContent(decoded, contentType);
    const content = truncateText(extracted.content, settings.webFetchMaxChars);
    if (!content) {
      throw new Error("웹페이지에서 읽을 수 있는 본문을 찾지 못했습니다.");
    }
    return {
      sourceUrl,
      finalUrl: currentUrl,
      title: truncateText(extracted.title, 300),
      content,
      contentType,
    };
  }

  throw new Error("웹페이지를 가져오지 못했습니다.");
}

export function parseWebFetchUrl(rawUrl: string): URL {
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    throw new Error("웹페이지 주소 길이가 올바르지 않습니다.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("웹페이지 주소 형식이 올바르지 않습니다.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP 또는 HTTPS 주소만 가져올 수 있습니다.");
  }
  if (url.username || url.password) {
    throw new Error("인증 정보가 포함된 주소는 가져올 수 없습니다.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    throw new Error("내부 네트워크 주소는 가져올 수 없습니다.");
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const allowedPort = url.protocol === "https:" ? "443" : "80";
  if (port !== allowedPort) {
    throw new Error("표준 웹 포트만 가져올 수 있습니다.");
  }
  if (isIP(hostname) > 0 && isBlockedAddress(hostname)) {
    throw new Error("내부 네트워크 주소는 가져올 수 없습니다.");
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    return true;
  }
  return BLOCKED_ADDRESSES.check(
    address,
    family === 6 ? "ipv6" : "ipv4",
  );
}

export function extractReadableContent(
  input: string,
  contentType: string,
): { title: string; content: string } {
  if (contentType === "application/json" || contentType === "application/ld+json") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return { title: "", content: normalizeText(JSON.stringify(parsed, null, 2)) };
    } catch {
      return { title: "", content: normalizeText(input) };
    }
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return { title: "", content: normalizeText(input) };
  }

  const title = decodeHtmlEntities(
    firstTagContent(input, "title").replace(/<[^>]+>/g, " "),
  ).trim();
  const description = extractMetaDescription(input);
  const cleaned = input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|template|svg|canvas|nav|footer|header|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
  const article = tagContents(cleaned, "article").join("\n");
  const main = tagContents(cleaned, "main").join("\n");
  const body = firstTagContent(cleaned, "body") || cleaned;
  const preferred = article.length >= 200 ? article : main.length >= 200 ? main : body;
  const visible = decodeHtmlEntities(
    preferred
      .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|table)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  );
  const normalizedDescription = normalizeText(decodeHtmlEntities(description));
  const normalizedVisible = normalizeText(visible);
  const content =
    normalizedDescription && !normalizedVisible.includes(normalizedDescription)
      ? `${normalizedDescription}\n\n${normalizedVisible}`
      : normalizedVisible;
  return { title: normalizeText(title), content };
}

async function resolvePublicAddress(
  hostname: string,
  timeoutMs: number,
): Promise<string> {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily > 0) {
    if (isBlockedAddress(normalized)) {
      throw new Error("내부 네트워크 주소는 가져올 수 없습니다.");
    }
    return normalized;
  }
  const addresses = await withTimeout(
    lookup(normalized, { all: true, verbatim: true }),
    timeoutMs,
  );
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("공개 웹 주소만 가져올 수 있습니다.");
  }
  return addresses[0]?.address ?? "";
}

function requestPinnedPage(params: {
  url: URL;
  address: string;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RawPage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: params.url.protocol,
      hostname: params.address,
      port: params.url.port || (params.url.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: `${params.url.pathname}${params.url.search}`,
      servername: params.url.hostname,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        accept:
          "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": USER_AGENT,
        host: params.url.host,
      },
    };
    const requester = params.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(options, (response) => {
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        response.resume();
        clearTimeout(timer);
        resolve({ status, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      if (status >= 200 && status < 300) {
        const contentType = normalizeContentType(response.headers["content-type"]);
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
          response.destroy();
          clearTimeout(timer);
          reject(new Error("지원하지 않는 웹페이지 형식입니다."));
          return;
        }
      }
      const encoding = readHeader(response.headers["content-encoding"]);
      if (encoding && encoding.toLowerCase() !== "identity") {
        response.destroy();
        clearTimeout(timer);
        reject(new Error("압축된 웹페이지 응답은 지원하지 않습니다."));
        return;
      }
      const contentLength = Number(readHeader(response.headers["content-length"]));
      if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
        response.destroy();
        clearTimeout(timer);
        reject(new Error("웹페이지 응답 크기가 제한을 초과했습니다."));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > params.maxBytes) {
          response.destroy(new Error("웹페이지 응답 크기가 제한을 초과했습니다."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve({
          status,
          headers: response.headers,
          body: Buffer.concat(chunks, totalBytes),
        });
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("웹페이지 요청 시간이 초과되었습니다."));
    }, params.timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function createBlockedAddresses(): BlockList {
  const blockList = new BlockList();
  const ipv4Subnets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const ipv6Subnets: Array<[string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:10::", 28],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [address, prefix] of ipv4Subnets) {
    blockList.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of ipv6Subnets) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function normalizeContentType(raw: string | string[] | undefined): string {
  return readHeader(raw).split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function readCharset(raw: string | string[] | undefined): string {
  const value = readHeader(raw);
  const matched = value.match(/charset\s*=\s*["']?([^;\s"']+)/i);
  return matched?.[1]?.trim() || "utf-8";
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function firstTagContent(input: string, tag: string): string {
  return tagContents(input, tag)[0] ?? "";
}

function tagContents(input: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  return Array.from(input.matchAll(pattern), (match) => match[1] ?? "");
}

function extractMetaDescription(input: string): string {
  const tags = input.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attributes = parseAttributes(tag);
    const key = (attributes.name ?? attributes.property ?? "").toLowerCase();
    if (key === "description" || key === "og:description" || key === "twitter:description") {
      return attributes.content ?? "";
    }
  }
  return "";
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    if (key) {
      attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  return attributes;
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    bull: "•",
    copy: "©",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    reg: "®",
    rsquo: "’",
    trade: "™",
  };
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return safeCodePoint(codePoint, full);
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return safeCodePoint(codePoint, full);
    }
    return named[entity.toLowerCase()] ?? full;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function normalizeText(input: string): string {
  const lines = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t \f\v]+/g, " ").trim())
    .filter((line) => line.length > 0);
  const deduplicated: string[] = [];
  for (const line of lines) {
    if (deduplicated[deduplicated.length - 1] !== line) {
      deduplicated.push(line);
    }
  }
  return deduplicated.join("\n").trim();
}

function truncateText(input: string, maxChars: number): string {
  const normalized = input.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const sliced = normalized.slice(0, maxChars);
  const boundary = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf(" "));
  const truncated = boundary >= Math.floor(maxChars * 0.75) ? sliced.slice(0, boundary) : sliced;
  return `${truncated.trimEnd()}\n...(생략)`;
}

function readHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("웹페이지 요청 시간이 초과되었습니다.");
  }
  return remaining;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("웹페이지 요청 시간이 초과되었습니다.")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
