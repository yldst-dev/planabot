import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { testSettings } from "../testing/settings.js";
import { invokeChatWithMetadata } from "./chat.js";
import { ProviderApiError } from "./providerError.js";
import { isSearchToolAvailable, providerHasCredentials } from "./providers/registry.js";
import { usesPreSearchContext } from "./search.js";

test("sub2api sends authenticated Luna requests, preserves history and images, and reports API errors", async () => {
  const requests: Array<{ authorization?: string; url?: string; body: Record<string, unknown> }> = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ authorization: req.headers.authorization, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? {
      model: "gpt-5.6-luna",
      choices: [{ message: { role: "assistant", content: "확인 완료." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    } : { error: { message: "Invalid API key" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const settings = testSettings({
    aiProvider: "sub2api",
    sub2ApiKey: "test-key",
    sub2ApiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    chatModel: "gpt-5.6-luna",
    chatMaxOutputTokens: 8192,
    chatThinkingMode: "low",
  });
  try {
    const messages = [
      { role: "developer" as const, content: "test" },
      { role: "user" as const, content: "test" },
      { role: "assistant" as const, content: "test" },
      { role: "user" as const, content: "test", images: [{ mimeType: "image/png", data: "AAAA" }] },
    ];
    const result = await invokeChatWithMetadata({ settings, messages });
    assert.equal(result.content, "확인 완료.");
    assert.equal(result.finishReason, "stop");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "/v1/chat/completions");
    assert.equal(requests[0]?.authorization, "Bearer test-key");
    assert.deepEqual(requests[0]?.body, {
      model: "gpt-5.6-luna",
      stream: false,
      max_completion_tokens: 8192,
      reasoning_effort: "low",
      messages: [
        ...messages.slice(0, 3),
        { role: "user", content: [
          { type: "text", text: "test" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ] },
      ],
    });
    for (const [mode, expected] of [["default", undefined], ["off", "none"], ["minimal", "low"]] as const) {
      await invokeChatWithMetadata({ settings: { ...settings, chatThinkingMode: mode }, messages: [{ role: "user", content: "test" }] });
      assert.equal(requests.at(-1)?.body.reasoning_effort, expected);
    }
    status = 401;
    const count = requests.length;
    await assert.rejects(invokeChatWithMetadata({ settings, messages }), (error: unknown) => {
      assert.ok(error instanceof ProviderApiError);
      assert.equal(error.kind, "auth_failed");
      assert.equal(error.provider, "sub2api");
      return true;
    });
    assert.equal(requests.length, count + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("sub2api requires its own credentials and exposes search only with configured pre-search", () => {
  const settings = testSettings({ aiProvider: "sub2api" });
  assert.equal(providerHasCredentials(settings, "sub2api"), false);
  assert.equal(providerHasCredentials({ ...settings, sub2ApiKey: "test-key" }, "sub2api"), false);
  assert.equal(providerHasCredentials({ ...settings, sub2ApiKey: "test-key", sub2ApiBaseUrl: "http://sub2api:8080/v1" }, "sub2api"), true);
  assert.equal(isSearchToolAvailable(settings), false);
  assert.equal(isSearchToolAvailable({ ...settings, ollamaWebSearchEnabled: true }), true);
  assert.equal(usesPreSearchContext({ ...settings, ollamaWebSearchEnabled: true, ollamaApiKeys: [] }), false);
});
