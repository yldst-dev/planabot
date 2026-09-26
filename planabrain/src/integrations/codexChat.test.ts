import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";

import { testSettings } from "../testing/settings.js";
import { currentExecution, runExecution } from "../runtime/execution.js";
import { invokeChatWithMetadata } from "./chat.js";
import { ProviderApiError } from "./providerError.js";
import { usesPreSearchContext } from "./search.js";

type Captured = { url?: string; authorization?: string; body: Record<string, unknown>; };

function sse(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

const HAPPY_EVENTS = sse([
  { type: "response.created", response: { id: "r1", output: [] } },
  { type: "response.in_progress", response: { id: "r1" } },
  { type: "response.output_item.added", item: { type: "message" } },
  { type: "response.content_part.added", part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", delta: "확인 " },
  { type: "response.output_text.delta", delta: "완료." },
  { type: "response.output_text.done", text: "확인 완료." },
  { type: "response.content_part.done" },
  { type: "response.output_item.done" },
  { type: "response.completed", response: { id: "r1", model: "gpt-6-astra", output: [], usage: { input_tokens: 21, output_tokens: 4 } } },
]);

async function withGateway(
  reply: (res: ServerResponse, index: number) => void,
  work: (baseUrl: string, requests: Captured[]) => Promise<void>,
): Promise<void> {
  const requests: Captured[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    reply(res, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await work(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    server.close();
  }
}

function streamChunks(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const joined = chunks.join("");
  const cut = Math.floor(joined.length / 3);
  res.write(joined.slice(0, cut));
  res.write(joined.slice(cut, cut * 2));
  res.end(joined.slice(cut * 2));
}

test("codex sends a Responses request that follows the gateway rules and reads the streamed text", async () => {
  await withGateway((res) => streamChunks(res, HAPPY_EVENTS), async (baseUrl, requests) => {
    const settings = testSettings({ codexApiKey: "cg_test", codexBaseUrl: baseUrl, chatModel: "gpt-6-astra", chatThinkingMode: "off", continuousChat: false });
    await runExecution("codex-test", async () => {
      const result = await invokeChatWithMetadata({
        settings,
        maxContinuations: 0,
        messages: [
          { role: "system", content: "프라나 말투로 답합니다." },
          { role: "user", content: "이전 질문" },
          { role: "assistant", content: "이전 답" },
          { role: "user", content: "이 사진 뭐야", images: [{ data: "AAAA", mimeType: "image/png" }] },
        ],
      });
      assert.equal(result.content, "확인 완료.");
      assert.equal(currentExecution()?.inputTokens, 21);
      assert.equal(currentExecution()?.outputTokens, 4);
    });
    const [request] = requests;
    assert.equal(request?.url, "/v1/responses");
    assert.equal(request?.authorization, "Bearer cg_test");
    assert.deepEqual(request?.body, {
      model: "gpt-6-astra",
      instructions: "프라나 말투로 답합니다.",
      input: [
        { role: "user", content: "이전 질문" },
        { role: "assistant", content: "이전 답" },
        { role: "user", content: [{ type: "input_text", text: "이 사진 뭐야" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      ],
      store: false,
      stream: true,
      reasoning: { effort: "low" },
    });
  });
});

test("codex falls back to the joined deltas and always sends instructions", async () => {
  const events = sse([
    { type: "response.output_text.delta", delta: "조각 " },
    { type: "response.output_text.delta", delta: "응답" },
    { type: "response.completed", response: { output: [] } },
  ]);
  await withGateway((res) => streamChunks(res, events), async (baseUrl, requests) => {
    const settings = testSettings({ codexApiKey: "cg_test", codexBaseUrl: baseUrl, chatThinkingMode: "default", continuousChat: false });
    const result = await invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] });
    assert.equal(result.content, "조각 응답");
    assert.ok(String(requests[0]?.body.instructions).length > 0);
    assert.equal("reasoning" in (requests[0]?.body ?? {}), false);
  });
});

test("codex reports gateway rule violations and failed streams as provider errors", async () => {
  await withGateway((res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Stream must be set to true" }));
  }, async (baseUrl) => {
    const settings = testSettings({ codexApiKey: "cg_test", codexBaseUrl: baseUrl, continuousChat: false });
    await assert.rejects(
      invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] }),
      (error: unknown) => error instanceof ProviderApiError && error.kind === "invalid_request" && error.apiMessage === "Stream must be set to true",
    );
  });
  await withGateway((res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Invalid API key" }));
  }, async (baseUrl, requests) => {
    const settings = testSettings({ codexApiKey: "cg_bad", codexBaseUrl: baseUrl, continuousChat: false });
    await assert.rejects(
      invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] }),
      (error: unknown) => error instanceof ProviderApiError && error.kind === "auth_failed",
    );
    assert.equal(requests.length, 1);
  });
  const failed = sse([{ type: "response.failed", response: { error: { message: "upstream request failed" } } }]);
  await withGateway((res, index) => streamChunks(res, index === 1 ? failed : HAPPY_EVENTS), async (baseUrl, requests) => {
    const settings = testSettings({ codexApiKey: "cg_test", codexBaseUrl: baseUrl, continuousChat: false });
    const result = await invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] });
    assert.equal(result.content, "확인 완료.");
    assert.equal(requests.length, 2);
  });
});

test("codex searches only through configured Ollama pre-search", () => {
  const settings = testSettings({ ollamaWebSearchEnabled: false });
  assert.equal(usesPreSearchContext(settings), false);
  assert.equal(usesPreSearchContext({ ...settings, ollamaWebSearchEnabled: true }), true);
  assert.equal(usesPreSearchContext({ ...settings, ollamaWebSearchEnabled: true, ollamaApiKeys: [] }), false);
});
