import assert from "node:assert/strict";
import test from "node:test";

import { testSettings } from "../testing/settings.js";
import { resolveAuxSettings } from "./auxSettings.js";

test("aux settings keep the main model and turn thinking off when nothing is configured", () => {
  const aux = resolveAuxSettings(testSettings({ chatModel: "gpt-6-luna", chatThinkingMode: "high" }));
  assert.equal(aux.chatModel, "gpt-6-luna");
  assert.equal(aux.chatThinkingMode, "off");
});

test("aux calls never use fast mode", () => {
  assert.equal(resolveAuxSettings(testSettings({ codexFast: true })).codexFast, false);
});

test("aux model swaps only the model", () => {
  const aux = resolveAuxSettings(testSettings({ chatModel: "gpt-6-luna", auxModel: "gpt-5.6-sol" }));
  assert.equal(aux.chatModel, "gpt-5.6-sol");
  assert.equal(aux.codexBaseUrl, "http://codex.example/v1");
});
