import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

import type { Settings } from "../config/settings.js";

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const MAX_HTML_TAG_CHARS = 8192;
const USER_AGENT = "Mozilla/5.0 (compatible; PlanabotWebFetch/1.0)";
const MAX_RESOLVED_ADDRESSES = 4;
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

class NonRetryableWebFetchError extends Error {}

export function extractUrls(text: string, maxUrls = 3): string[] {
  if (!Number.isSafeInteger(maxUrls) || maxUrls <= 0) {
    return [];
  }
  const matches = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  const urls = new Set<string>();
  for (const match of matches) {
    const candidate = trimUrlCandidate(match);
    if (!candidate || candidate.length > MAX_URL_LENGTH) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") {
        urls.add(url.toString());
      }
    } catch {
      continue;
    }
    if (urls.size === maxUrls) {
      break;
    }
  }
  return Array.from(urls);
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
    const addresses = await resolvePublicAddresses(
      url.hostname,
      remainingTime(deadline),
    );
    const response = await requestFromPublicAddress({
      url,
      addresses,
      deadline,
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
    const decoded = decodeWebBody(
      response.body,
      response.headers["content-type"],
      contentType,
    );
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
  const extracted = extractHtmlSections(input);
  const normalizedDescription = normalizeText(
    decodeHtmlEntities(extracted.description),
  );
  const normalizedArticle = normalizeText(decodeHtmlEntities(extracted.article));
  const normalizedMain = normalizeText(decodeHtmlEntities(extracted.main));
  const normalizedBody = normalizeText(decodeHtmlEntities(extracted.body));
  const normalizedGeneral = normalizeText(decodeHtmlEntities(extracted.general));
  const normalizedVisible =
    normalizedArticle.length >= 200
      ? normalizedArticle
      : normalizedMain.length >= 200
        ? normalizedMain
        : normalizedBody || normalizedGeneral;
  const content =
    normalizedDescription && !normalizedVisible.includes(normalizedDescription)
      ? `${normalizedDescription}\n\n${normalizedVisible}`
      : normalizedVisible;
  return {
    title: normalizeText(decodeHtmlEntities(extracted.title)),
    content,
  };
}

async function resolvePublicAddresses(
  hostname: string,
  timeoutMs: number,
): Promise<string[]> {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily > 0) {
    if (isBlockedAddress(normalized)) {
      throw new Error("내부 네트워크 주소는 가져올 수 없습니다.");
    }
    return [normalized];
  }
  const addresses = await withTimeout(
    lookup(normalized, { all: true, verbatim: true }),
    timeoutMs,
  );
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("공개 웹 주소만 가져올 수 있습니다.");
  }
  return Array.from(new Set(addresses.map((entry) => entry.address))).slice(
    0,
    MAX_RESOLVED_ADDRESSES,
  );
}

async function requestFromPublicAddress(params: {
  url: URL;
  addresses: string[];
  deadline: number;
  maxBytes: number;
}): Promise<RawPage> {
  let lastError: unknown;
  for (const address of params.addresses) {
    try {
      return await requestPinnedPage({
        url: params.url,
        address,
        timeoutMs: remainingTime(params.deadline),
        maxBytes: params.maxBytes,
      });
    } catch (error) {
      if (error instanceof NonRetryableWebFetchError) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new Error("웹페이지 연결에 실패했습니다.");
}

function requestPinnedPage(params: {
  url: URL;
  address: string;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RawPage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const resolveOnce = (page: RawPage) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(page);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
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
        resolveOnce({ status, headers: response.headers, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      if (status < 200 || status >= 300) {
        resolveOnce({ status, headers: response.headers, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      const contentType = normalizeContentType(response.headers["content-type"]);
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        rejectOnce(new NonRetryableWebFetchError("지원하지 않는 웹페이지 형식입니다."));
        response.destroy();
        return;
      }
      const encoding = readHeader(response.headers["content-encoding"]);
      if (encoding && encoding.toLowerCase() !== "identity") {
        rejectOnce(new NonRetryableWebFetchError("압축된 웹페이지 응답은 지원하지 않습니다."));
        response.destroy();
        return;
      }
      const contentLengthHeader = readHeader(response.headers["content-length"]);
      const contentLength = Number(contentLengthHeader);
      if (
        contentLengthHeader &&
        (!Number.isSafeInteger(contentLength) || contentLength < 0)
      ) {
        rejectOnce(new NonRetryableWebFetchError("웹페이지 응답 크기가 올바르지 않습니다."));
        response.destroy();
        return;
      }
      if (contentLength > params.maxBytes) {
        rejectOnce(new NonRetryableWebFetchError("웹페이지 응답 크기가 제한을 초과했습니다."));
        response.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > params.maxBytes) {
          rejectOnce(new NonRetryableWebFetchError("웹페이지 응답 크기가 제한을 초과했습니다."));
          response.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        resolveOnce({
          status,
          headers: response.headers,
          body: Buffer.concat(chunks, totalBytes),
        });
      });
      response.on("error", (error) => {
        rejectOnce(error);
      });
    });
    timer = setTimeout(() => {
      const error = new Error("웹페이지 요청 시간이 초과되었습니다.");
      rejectOnce(error);
      request.destroy();
    }, params.timeoutMs);
    request.on("error", (error) => {
      rejectOnce(error);
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
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
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

function trimUrlCandidate(input: string): string {
  let candidate = input.replace(/[.,;:!?}'"`]+$/, "");
  let opening = countCharacter(candidate, "(");
  let closing = countCharacter(candidate, ")");
  while (candidate.endsWith(")") && closing > opening) {
    candidate = candidate.slice(0, -1);
    closing -= 1;
  }
  opening = countCharacter(candidate, "[");
  closing = countCharacter(candidate, "]");
  while (candidate.endsWith("]") && closing > opening) {
    candidate = candidate.slice(0, -1);
    closing -= 1;
  }
  return candidate;
}

function countCharacter(input: string, target: string): number {
  let count = 0;
  for (const character of input) {
    if (character === target) {
      count += 1;
    }
  }
  return count;
}

function normalizeContentType(raw: string | string[] | undefined): string {
  return readHeader(raw).split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function readCharset(raw: string | string[] | undefined): string | undefined {
  const value = readHeader(raw);
  const matched = value.match(/charset\s*=\s*["']?([^;\s"']+)/i);
  return matched?.[1]?.trim();
}

export function decodeWebBody(
  body: Buffer,
  contentTypeHeader: string | string[] | undefined,
  contentType: string,
): string {
  const charset =
    readBomCharset(body) ??
    readCharset(contentTypeHeader) ??
    readMetaCharset(body, contentType) ??
    "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    throw new NonRetryableWebFetchError("지원하지 않는 문자 인코딩입니다.");
  }
}

function readBomCharset(body: Buffer): string | undefined {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return "utf-8";
  }
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return "utf-16le";
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return "utf-16be";
  }
  return undefined;
}

function readMetaCharset(body: Buffer, contentType: string): string | undefined {
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return undefined;
  }
  const prefix = body.subarray(0, 8192).toString("latin1");
  const metaTags = prefix.match(/<meta\b[^>]{0,1024}>/gi) ?? [];
  for (const tag of metaTags) {
    const attributes = parseAttributes(tag);
    if (attributes.charset) {
      return attributes.charset.trim();
    }
    if ((attributes["http-equiv"] ?? "").toLowerCase() === "content-type") {
      const charset = readCharset(attributes.content);
      if (charset) {
        return charset;
      }
    }
  }
  return undefined;
}

type HtmlSections = {
  title: string;
  description: string;
  article: string;
  main: string;
  body: string;
  general: string;
};

function extractHtmlSections(input: string): HtmlSections {
  const lower = input.toLowerCase();
  const hiddenTags = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "nav",
    "footer",
    "aside",
    "form",
    "dialog",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
  ]);
  const blockTags = new Set([
    "address",
    "article",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "main",
    "p",
    "pre",
    "section",
    "table",
    "td",
    "th",
    "tr",
  ]);
  const sections: Record<keyof HtmlSections, string[]> = {
    title: [],
    description: [],
    article: [],
    main: [],
    body: [],
    general: [],
  };
  const hiddenStack: string[] = [];
  let articleDepth = 0;
  let mainDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let titleDepth = 0;
  let cursor = 0;

  const append = (text: string) => {
    if (!text || hiddenStack.length > 0) {
      return;
    }
    if (titleDepth > 0) {
      sections.title.push(text);
      return;
    }
    if (headDepth > 0) {
      return;
    }
    sections.general.push(text);
    if (bodyDepth > 0) {
      sections.body.push(text);
    }
    if (mainDepth > 0) {
      sections.main.push(text);
    }
    if (articleDepth > 0) {
      sections.article.push(text);
    }
  };

  while (cursor < input.length) {
    const tagStart = input.indexOf("<", cursor);
    if (tagStart < 0) {
      append(input.slice(cursor));
      break;
    }
    append(input.slice(cursor, tagStart));
    if (lower.startsWith("<!--", tagStart)) {
      const commentEnd = lower.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) {
        break;
      }
      cursor = commentEnd + 3;
      continue;
    }
    const tagEnd = input.indexOf(">", tagStart + 1);
    if (tagEnd < 0) {
      break;
    }
    const rawTag = input.slice(tagStart + 1, tagEnd);
    const parsed = parseHtmlTag(rawTag);
    cursor = tagEnd + 1;
    if (!parsed) {
      continue;
    }
    const { name, closing, selfClosing } = parsed;

    if (hiddenStack.length > 0) {
      if (!closing && !selfClosing && hiddenTags.has(name)) {
        hiddenStack.push(name);
      } else if (closing && hiddenStack[hiddenStack.length - 1] === name) {
        hiddenStack.pop();
      }
      continue;
    }
    if (!closing && hiddenTags.has(name)) {
      if (!selfClosing) {
        hiddenStack.push(name);
      }
      continue;
    }
    if (
      !closing &&
      name === "meta" &&
      rawTag.length <= MAX_HTML_TAG_CHARS &&
      sections.description.length === 0
    ) {
      const attributes = parseAttributes(rawTag);
      const key = (attributes.name ?? attributes.property ?? "").toLowerCase();
      if (
        key === "description" ||
        key === "og:description" ||
        key === "twitter:description"
      ) {
        sections.description.push(attributes.content ?? "");
      }
    }
    if (closing) {
      if (blockTags.has(name)) {
        append("\n");
      }
      if (name === "article" && articleDepth > 0) {
        articleDepth -= 1;
      } else if (name === "main" && mainDepth > 0) {
        mainDepth -= 1;
      } else if (name === "body" && bodyDepth > 0) {
        bodyDepth -= 1;
      } else if (name === "head" && headDepth > 0) {
        headDepth -= 1;
      } else if (name === "title" && titleDepth > 0) {
        titleDepth -= 1;
      }
      continue;
    }
    if (name === "article") {
      articleDepth += 1;
    } else if (name === "main") {
      mainDepth += 1;
    } else if (name === "body") {
      bodyDepth += 1;
    } else if (name === "head") {
      headDepth += 1;
    } else if (name === "title") {
      titleDepth += 1;
    }
    if (name === "li") {
      append("\n- ");
    } else if (name === "br" || name === "hr") {
      append("\n");
    }
  }

  return {
    title: sections.title.join(""),
    description: sections.description.join(""),
    article: sections.article.join(""),
    main: sections.main.join(""),
    body: sections.body.join(""),
    general: sections.general.join(""),
  };
}

function parseHtmlTag(
  rawTag: string,
): { name: string; closing: boolean; selfClosing: boolean } | null {
  const trimmed = rawTag.trim();
  if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("?")) {
    return null;
  }
  const closing = trimmed.startsWith("/");
  const nameStart = closing ? 1 : 0;
  let nameEnd = nameStart;
  while (nameEnd < trimmed.length && /[a-z0-9:-]/i.test(trimmed[nameEnd] ?? "")) {
    nameEnd += 1;
  }
  if (nameEnd === nameStart) {
    return null;
  }
  return {
    name: trimmed.slice(nameStart, nameEnd).toLowerCase(),
    closing,
    selfClosing: !closing && trimmed.endsWith("/"),
  };
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
