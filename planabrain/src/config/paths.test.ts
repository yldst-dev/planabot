import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveDataPath, resolveDataRoot } from "./paths.js";

test("data root defaults to the repository root above the package", () => {
  const root = resolveDataRoot({});
  assert.equal(root, path.resolve(process.cwd(), ".."));
});

test("data root honors PLANABRAIN_DATA_DIR as absolute or cwd-relative", () => {
  assert.equal(resolveDataRoot({ PLANABRAIN_DATA_DIR: "/srv/planabot" }), "/srv/planabot");
  assert.equal(
    resolveDataRoot({ PLANABRAIN_DATA_DIR: "state" }),
    path.resolve(process.cwd(), "state"),
  );
  assert.equal(resolveDataRoot({ PLANABRAIN_DATA_DIR: "   " }), path.resolve(process.cwd(), ".."));
});

test("data paths resolve against the data root unless absolute", () => {
  const env = { PLANABRAIN_DATA_DIR: "/srv/planabot" };
  assert.equal(
    resolveDataPath(".planabrain/index.json", env),
    "/srv/planabot/.planabrain/index.json",
  );
  assert.equal(resolveDataPath("/var/lib/memory", env), "/var/lib/memory");
});
