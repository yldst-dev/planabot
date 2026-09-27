import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAsk } from "./turnService.js";
import { testSettings } from "../testing/settings.js";
import { codexInputText, codexStream, installFetch } from "../testing/codex.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const settings = () => testSettings({ ollamaWebSearchEnabled: false, deliveryRewriteEnabled: false });

function imageParts(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const input = Array.isArray(body.input) ? body.input as Array<{ content: unknown; }> : [];
  return input.flatMap((item) => Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [])
    .filter((part) => part.type === "input_image");
}

test("server image input rejects paths outside the upload directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-validation-"));
  const uploads = path.join(root, "uploads");
  const mock = installFetch(() => { throw new Error("unexpected model request"); });
  try {
    await mkdir(uploads);
    const outside = path.join(root, "outside.png");
    await writeFile(outside, PNG);
    const input = { userId: "actor", question: "사진 설명" };
    await assert.rejects(runAsk({ ...input, image: { path: outside, mimeType: "image/png" } }, settings(), uploads), /허용된 이미지 폴더/u);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid images are skipped and the model is told why instead of failing the turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-notice-"));
  const mock = installFetch(() => codexStream("받지 못한 이미지가 있습니다."));
  try {
    const good = path.join(root, "good.png");
    const bad = path.join(root, "bad.png");
    await writeFile(good, PNG);
    await writeFile(bad, "PRIVATE_VALUE=synthetic");
    const result = await runAsk({
      userId: "actor",
      question: "사진 설명",
      images: [{ path: good, mimeType: "image/png" }, { path: bad, mimeType: "image/png" }],
      imageNotice: "요청이 잦아 한 장은 확인하지 않았습니다.",
    }, settings(), root);
    assert.match(result.answer, /받지 못한 이미지/u);
    const [request] = mock.codexRequests();
    assert.equal(imageParts(request.body).length, 1);
    const text = codexInputText(request);
    assert.match(text, /IMAGE_STATUS/u);
    assert.match(text, /요청이 잦아/u);
    assert.match(text, /지원하지 않는 형식/u);
    assert.doesNotMatch(text, /PRIVATE_VALUE/u);
  } finally {
    mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("several attached images reach the model together with the configured detail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-multi-"));
  const mock = installFetch(() => codexStream("두 장 확인했습니다."));
  try {
    const first = path.join(root, "a.png");
    const second = path.join(root, "b.webp");
    await writeFile(first, PNG);
    await writeFile(second, WEBP);
    await runAsk({
      userId: "actor",
      question: "프라나야 이거 비교해줘",
      images: [{ path: first, mimeType: "image/png" }, { path: second, mimeType: "image/webp" }],
    }, testSettings({ ollamaWebSearchEnabled: false, deliveryRewriteEnabled: false, codexImageDetail: "low" }), root);
    const [request] = mock.codexRequests();
    const urls = imageParts(request.body).map((part) => String(part.image_url).slice(0, 30));
    assert.deepEqual(urls, ["data:image/png;base64,iVBORw0K", "data:image/webp;base64,UklGRgA"]);
    assert.ok(imageParts(request.body).every((part) => part.detail === "low"));
  } finally {
    mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("image links are fetched locally and a broken link becomes a notice instead of a failed turn", async () => {
  const mock = installFetch(() => codexStream("링크 이미지를 가져오지 못했습니다."));
  try {
    const question = "프라나야 이 사진 봐줘 https://images.invalid/cat.png https://example.invalid/page";
    await runAsk({ userId: "actor", question }, testSettings({ ollamaWebSearchEnabled: false, deliveryRewriteEnabled: false, webFetchEnabled: true }));
    const [request] = mock.codexRequests();
    assert.equal(imageParts(request.body).length, 0);
    assert.match(codexInputText(request), /이미지 링크를 가져오지 못했습니다/u);
    assert.equal(JSON.stringify(request.body).includes("\"image_url\":\"https://"), false);

    await runAsk({ userId: "actor", question }, testSettings({ ollamaWebSearchEnabled: false, deliveryRewriteEnabled: false, webFetchEnabled: false }));
    const second = mock.codexRequests()[1];
    assert.doesNotMatch(codexInputText(second), /IMAGE_STATUS/u);
  } finally {
    mock.restore();
  }
});
