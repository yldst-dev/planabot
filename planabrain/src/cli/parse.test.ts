import assert from "node:assert/strict";
import test from "node:test";

import { parseCli } from "./parse.js";
import { COMMAND_NAMES } from "./registry.js";

test("every registered command parses with its arguments", () => {
  for (const name of COMMAND_NAMES) {
    const parsed = parseCli(["node", "cli", name, "a", "b"]);
    assert.equal(parsed.command, name);
    assert.deepEqual(parsed.args, ["a", "b"]);
  }
});

test("unknown or missing commands fail with the usage line", () => {
  assert.throws(() => parseCli(["node", "cli", "nope"]), /Usage: planabrain </u);
  assert.throws(() => parseCli(["node", "cli"]), /Usage: planabrain </u);
  assert.throws(() => parseCli(["node", "cli", "constructor"]), /Usage/u);
});

test("registry no longer exposes the removed ingest command", () => {
  assert.ok(!COMMAND_NAMES.includes("ingest" as never));
  assert.ok(COMMAND_NAMES.includes("turn-prepare"));
});
