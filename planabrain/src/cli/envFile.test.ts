import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readEnvOrFile } from "./envFile.js";

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("a value too large for env is read from its file and kept byte for byte", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "planabrain-envfile-"));
  const file = path.join(dir, "value.tmp");
  const value = ` ${"가나다".repeat(20000)}\n`;
  await writeFile(file, value);
  try {
    await withEnv({ PLANABRAIN_TEST_VALUE: undefined, PLANABRAIN_TEST_VALUE_FILE: file }, async () => {
      assert.equal(await readEnvOrFile("PLANABRAIN_TEST_VALUE"), value);
    });
    await withEnv({ PLANABRAIN_TEST_VALUE: "inline", PLANABRAIN_TEST_VALUE_FILE: file }, async () => {
      assert.equal(await readEnvOrFile("PLANABRAIN_TEST_VALUE"), value);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a small value keeps coming from env and a missing value stays undefined", async () => {
  await withEnv({ PLANABRAIN_TEST_VALUE: "inline", PLANABRAIN_TEST_VALUE_FILE: undefined }, async () => {
    assert.equal(await readEnvOrFile("PLANABRAIN_TEST_VALUE"), "inline");
  });
  await withEnv({ PLANABRAIN_TEST_VALUE: undefined, PLANABRAIN_TEST_VALUE_FILE: "  " }, async () => {
    assert.equal(await readEnvOrFile("PLANABRAIN_TEST_VALUE"), undefined);
  });
});

test("an unreadable file names its variable instead of dropping the value", async () => {
  await withEnv({ PLANABRAIN_TEST_VALUE: "inline", PLANABRAIN_TEST_VALUE_FILE: path.join(os.tmpdir(), "planabrain-envfile-missing.tmp") }, async () => {
    await assert.rejects(readEnvOrFile("PLANABRAIN_TEST_VALUE"), /PLANABRAIN_TEST_VALUE_FILE 읽기 실패/u);
  });
});
