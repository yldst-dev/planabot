import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderApiError,
  hasErrorPayload,
  resolveErrorStatus,
} from "./httpError.js";

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
    new Response("{}", { status: 200 }),
  );
  assert.equal(error.kind, "provider_unavailable");
  assert.equal(error.status, 504);
  assert.equal(error.retryable, true);
  assert.equal(error.upstreamProvider, "Morph");
  assert.match(error.apiMessage, /timed out/u);
});
