import assert from "node:assert/strict";
import test from "node:test";

import { ProviderApiError } from "../providerError.js";
import {
  buildProviderApiError,
  hasErrorPayload,
  invokeOpenAICompatibleChat,
  resolveErrorStatus,
} from "./openAI.js";

test("hasErrorPayload detects OpenRouter 200 timeout bodies", () => {
  assert.equal(
    hasErrorPayload({
      id: "gen-1",
      error: { message: "Provider timed out after 301455ms", code: 504 },
    }),
    true,
  );
  assert.equal(hasErrorPayload({ choices: [{ message: { content: "ok" } }] }), false);
});

test("resolveErrorStatus prefers nested OpenRouter error codes", () => {
  assert.equal(
    resolveErrorStatus(
      { error: { message: "Provider timed out after 301455ms", code: 504 } },
      200,
    ),
    504,
  );
  assert.equal(resolveErrorStatus({ error: { message: "upstream failed" } }, 200), 502);
});

test("buildProviderApiError maps 200 timeout bodies to retryable unavailability", () => {
  const error = buildProviderApiError(
    "OpenRouter",
    {
      id: "gen-1",
      error: {
        message: "Provider timed out after 301455ms",
        code: 504,
        metadata: { error_type: "timeout", provider_name: "Morph" },
      },
    },
    new Response("{}", {
      status: 200,
      headers: { "x-openrouter-provider": "Morph" },
    }),
  );
  assert.equal(error.kind, "provider_unavailable");
  assert.equal(error.status, 504);
  assert.equal(error.retryable, true);
  assert.equal(error.upstreamProvider, "Morph");
  assert.match(error.apiMessage, /timed out/u);
});

test("invokeOpenAICompatibleChat throws retryable error for 200 timeout bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "gen-1",
        error: { message: "Provider timed out after 301455ms", code: 504 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    await assert.rejects(
      invokeOpenAICompatibleChat({
        providerName: "OpenRouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        payload: { model: "z-ai/glm-5.3-flash", messages: [] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderApiError);
        assert.equal(error.kind, "provider_unavailable");
        assert.equal(error.status, 504);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
