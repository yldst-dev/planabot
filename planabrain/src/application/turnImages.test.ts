import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractImageUrls, isImageUrl, sniffImageType, youtubeThumbnail } from "../chat/imageLinks.js";
import { testSettings } from "../testing/settings.js";
import { resolveTurnImages } from "./turnImages.js";

test("image types come from the file signature, not the name", () => {
  assert.equal(sniffImageType(Buffer.from([255, 216, 255, 224])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(sniffImageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
  assert.equal(sniffImageType(Buffer.from("<html>")), undefined);
  assert.equal(sniffImageType(Buffer.alloc(0)), undefined);
});

test("only https links whose path ends in an image extension count as images", () => {
  assert.equal(isImageUrl("https://cdn.example.com/a/b.JPG?w=800"), true);
  assert.equal(isImageUrl("http://cdn.example.com/b.png"), false);
  assert.equal(isImageUrl("https://example.com/page"), false);
  assert.equal(isImageUrl("https://example.com/png"), false);
  assert.deepEqual(
    extractImageUrls("a https://x.example/1.png b https://x.example/page c https://x.example/2.webp", 1),
    ["https://x.example/1.png"],
  );
  assert.deepEqual(extractImageUrls("https://x.example/1.png", 0), []);
});

test("youtube links map straight to their thumbnail without loading the page", () => {
  const thumb = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtube.com/live/dQw4w9WgXcQ",
  ]) {
    assert.equal(youtubeThumbnail(url), thumb, url);
  }
  assert.equal(youtubeThumbnail("https://www.youtube.com/@channel"), undefined);
  assert.equal(youtubeThumbnail("https://www.youtube.com/watch?v=short"), undefined);
  assert.equal(youtubeThumbnail("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), undefined);
  assert.equal(youtubeThumbnail("not a url"), undefined);
});

test("images too large for the Claude API are skipped with a notice before the request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabot-images-"));
  try {
    const file = path.join(dir, "large.png");
    await writeFile(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4_000_000)]));
    const files = [{ path: file, mimeType: "image/png" }];
    const claude = await resolveTurnImages({ files, text: "", settings: testSettings({ aiProvider: "anthropic", webFetchEnabled: false }) });
    assert.equal(claude.images, undefined);
    assert.equal(claude.imageNotice, "3.75MB를 넘는 이미지는 확인하지 않았습니다.");
    const codex = await resolveTurnImages({ files, text: "", settings: testSettings({ webFetchEnabled: false }) });
    assert.equal(codex.images?.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
