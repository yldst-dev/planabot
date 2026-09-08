import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeOpenRouterBaseUrl } from "../config/settings.js";

const KEY = "PLANABRAIN_OPENROUTER_BASE_URL";

test("normalizeOpenRouterBaseUrl falls back to the official endpoint", () => {
  assert.equal(normalizeOpenRouterBaseUrl(undefined, KEY), "https://openrouter.ai/api/v1");
  assert.equal(normalizeOpenRouterBaseUrl("   ", KEY), "https://openrouter.ai/api/v1");
});

test("normalizeOpenRouterBaseUrl appends /api/v1 only when no path is given", () => {
  assert.equal(normalizeOpenRouterBaseUrl("https://openrouter.ai", KEY), "https://openrouter.ai/api/v1");
  assert.equal(normalizeOpenRouterBaseUrl("https://openrouter.ai/", KEY), "https://openrouter.ai/api/v1");
  assert.equal(
    normalizeOpenRouterBaseUrl("https://openrouter.ai/api/v1/", KEY),
    "https://openrouter.ai/api/v1",
  );
});

test("normalizeOpenRouterBaseUrl keeps custom gateway paths", () => {
  assert.equal(normalizeOpenRouterBaseUrl("http://127.0.0.1:8083/v1", KEY), "http://127.0.0.1:8083/v1");
  assert.equal(normalizeOpenRouterBaseUrl("http://127.0.0.1:8083/v1/", KEY), "http://127.0.0.1:8083/v1");
});

test("normalizeOpenRouterBaseUrl rejects invalid urls", () => {
  assert.throws(() => normalizeOpenRouterBaseUrl("ftp://example.com", KEY), /PLANABRAIN_OPENROUTER_BASE_URL/);
  assert.throws(() => normalizeOpenRouterBaseUrl("not a url", KEY), /valid http/);
});
