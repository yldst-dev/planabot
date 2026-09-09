import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAsk } from "./turnService.js";
import { testSettings } from "../testing/settings.js";

test("server image input rejects paths outside the upload directory and non-images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-validation-"));
  const uploads = path.join(root, "uploads");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected model request"); };
  try {
    await mkdir(uploads);
    const outside = path.join(root, "outside.png");
    const inside = path.join(uploads, "invalid.png");
    await writeFile(outside, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(inside, "PRIVATE_VALUE=synthetic");
    const input = { userId: "actor", question: "사진 설명", memoryEnabled: false };
    await assert.rejects(runAsk({ ...input, image: { path: outside, mimeType: "image/png" } }, testSettings(), uploads), /허용된 이미지 폴더/u);
    await assert.rejects(runAsk({ ...input, image: { path: inside, mimeType: "image/png" } }, testSettings(), uploads), /파일 형식이 일치하지/u);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});
