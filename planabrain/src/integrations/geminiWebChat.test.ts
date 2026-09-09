import assert from "node:assert/strict";
import test from "node:test";

import type { Settings } from "../config/settings.js";
import { invokeChatWithMetadata } from "./chat.js";

function settingsFor(overrides: Partial<Settings> = {}): Settings {
  return {
    aiProvider: "geminiweb",
    geminiWebApiKey: "sk-gemini-test",
    geminiWebBaseUrl: "http://10.0.0.5:8083/v1",
    chatModel: "gemini-3.8-flash",
    ollamaApiKeys: [],
    ...overrides,
  } as Settings;
}

function openaiChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("geminiweb posts to /v1/chat/completions with bearer auth and no tools", async () => {
  const original = globalThis.fetch;
  const recorded: Array<{
    url: string;
    method: string | undefined;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    recorded.push({
      url,
      method: init?.method,
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return openaiChatResponse("정리 완료.");
  }) as typeof fetch;
  try {
    const result = await invokeChatWithMetadata({
      settings: settingsFor({ chatMaxOutputTokens: 2048 }),
      messages: [{ role: "user", content: "안녕" }],
    });
    assert.equal(result.content, "정리 완료.");
    assert.equal(recorded.length, 1);
    const request = recorded[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "http://10.0.0.5:8083/v1/chat/completions");
    assert.equal(request.authorization, "Bearer sk-gemini-test");
    assert.equal(request.body.model, "gemini-3.8-flash");
    assert.equal(request.body.temperature, 1.0);
    assert.equal(request.body.top_p, 0.7);
    assert.equal(request.body.max_tokens, 2048);
    assert.equal("tools" in request.body, false);
    assert.equal("tool_choice" in request.body, false);
    assert.equal("stream" in request.body, false);
    assert.equal("n" in request.body, false);
    assert.equal("provider" in request.body, false);
    const messages = request.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages, [{ role: "user", content: "안녕" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("geminiweb sends image_url data urls and omits tools", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return openaiChatResponse("확인 완료.");
  }) as typeof fetch;
  try {
    await invokeChatWithMetadata({
      settings: settingsFor(),
      messages: [
        {
          role: "user",
          content: "이 사진 봐줘",
          images: [{ mimeType: "image/png", data: "AAAA" }],
        },
      ],
    });
    assert.ok(body);
    assert.equal("tools" in body, false);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.content, [
      { type: "text", text: "이 사진 봐줘" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
