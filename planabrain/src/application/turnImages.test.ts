import assert from "node:assert/strict";
import test from "node:test";
import { sniffImageType } from "./turnImages.js";
import { extractImageUrls, isImageUrl } from "../chat/imageLinks.js";

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
