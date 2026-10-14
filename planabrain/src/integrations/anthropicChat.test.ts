import assert from "node:assert/strict";
import test from "node:test";

import { currentExecution, runExecution } from "../runtime/execution.js";
import { installFetch, jsonResponse } from "../testing/codex.js";
import { testSettings } from "../testing/settings.js";
import { invokeChatWithMetadata } from "./chat.js";
import { ProviderApiError } from "./providerError.js";
import { ANTHROPIC_MESSAGES_URL } from "./providers/anthropic.js";

const settings = testSettings({ aiProvider: "anthropic", anthropicApiKey: "sk-ant-test", chatModel: "claude-opus-5-5", continuousChat: false });

function message(text: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "thinking", thinking: "", signature: "sig" }, ...(text ? [{ type: "text", text }] : [])],
    stop_reason: "end_turn",
    usage: { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 1200 },
    ...extra,
  });
}

test("anthropic sends a Messages request with a cached system block and images before text", async () => {
  const mock = installFetch(() => message("확인 완료."));
  try {
    await runExecution("anthropic-test", async () => {
      const result = await invokeChatWithMetadata({
        settings,
        maxContinuations: 0,
        messages: [
          { role: "system", content: "프라나 말투로 답합니다." },
          { role: "user", content: "이전 질문" },
          { role: "assistant", content: "이전 답" },
          { role: "user", content: "" },
          { role: "user", content: "이 사진 뭐야", images: [{ data: "AAAA", mimeType: "image/png" }] },
        ],
      });
      assert.equal(result.content, "확인 완료.");
      assert.equal(currentExecution()?.inputTokens, 30);
      assert.equal(currentExecution()?.cachedInputTokens, 1200);
    });
    const [request] = mock.requests;
    assert.equal(request?.url, ANTHROPIC_MESSAGES_URL);
    assert.equal(request?.headers.get("x-api-key"), "sk-ant-test");
    assert.equal(request?.headers.get("anthropic-version"), "2023-06-01");
    assert.deepEqual(request?.body, {
      model: "claude-opus-5-5",
      max_tokens: 32000,
      system: [{ type: "text", text: "프라나 말투로 답합니다.", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "이전 질문" }] },
        { role: "assistant", content: [{ type: "text", text: "이전 답" }] },
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "이 사진 뭐야" },
          ],
        },
      ],
      output_config: { effort: "low" },
    });
  } finally { mock.restore(); }
});

test("anthropic maps the thinking mode to effort and never sends sampling parameters", async () => {
  const mock = installFetch(() => message("응답"));
  try {
    for (const mode of ["default", "medium", "high"] as const) {
      await invokeChatWithMetadata({ settings: { ...settings, chatThinkingMode: mode }, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] });
    }
    const bodies = mock.requests.map((request) => request.body);
    assert.equal("output_config" in bodies[0]!, false);
    assert.deepEqual(bodies[1]?.output_config, { effort: "medium" });
    assert.deepEqual(bodies[2]?.output_config, { effort: "high" });
    for (const body of bodies) {
      assert.equal("temperature" in body || "top_p" in body || "thinking" in body, false);
    }
  } finally { mock.restore(); }
});

test("anthropic retries overload, rejects bad keys, and treats an empty refusal as blocked content", async () => {
  let calls = 0;
  const overloaded = installFetch(() => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "retry-after": "0" } })
      : message("복구됨");
  });
  try {
    const result = await invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] });
    assert.equal(result.content, "복구됨");
    assert.equal(overloaded.requests.length, 2);
  } finally { overloaded.restore(); }

  const unauthorized = installFetch(() => jsonResponse({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
  try {
    await assert.rejects(
      invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] }),
      (error: unknown) => error instanceof ProviderApiError && error.kind === "auth_failed" && error.apiMessage === "invalid x-api-key",
    );
    assert.equal(unauthorized.requests.length, 1);
  } finally { unauthorized.restore(); }

  const refused = installFetch(() => message("", { stop_reason: "refusal" }));
  try {
    await assert.rejects(
      invokeChatWithMetadata({ settings, maxContinuations: 0, messages: [{ role: "user", content: "안녕" }] }),
      (error: unknown) => error instanceof ProviderApiError && error.kind === "empty_or_filtered" && /content blocked/u.test(error.message),
    );
    assert.equal(refused.requests.length, 1);
  } finally { refused.restore(); }
});

test("anthropic continues an answer cut off by max_tokens", async () => {
  let calls = 0;
  const mock = installFetch(() => {
    calls += 1;
    return calls === 1 ? message("첫 문장.", { stop_reason: "max_tokens" }) : message("다음 문장.");
  });
  try {
    const result = await invokeChatWithMetadata({ settings, maxContinuations: 1, messages: [{ role: "user", content: "길게 설명해줘" }] });
    assert.equal(mock.requests.length, 2);
    assert.match(result.content, /첫 문장\.[\s\S]*다음 문장\./u);
    const last = (mock.requests[1]?.body.messages as Array<{ role: string; }>).at(-1);
    assert.equal(last?.role, "user");
  } finally { mock.restore(); }
});
