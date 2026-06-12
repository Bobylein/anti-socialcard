import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnvFile } from "../scripts/load-env.mjs";

test("loads .env values without overriding existing environment variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anti-socialcard-env-"));
  const path = join(directory, ".env");
  await writeFile(path, "NEXTCLOUD_SHARE_URL='https://cloud.example/s/token'\nEXISTING=from-file\n");
  const env = { EXISTING: "from-environment" };
  try {
    assert.equal(await loadEnvFile(path, env), true);
    assert.equal(env.NEXTCLOUD_SHARE_URL, "https://cloud.example/s/token");
    assert.equal(env.EXISTING, "from-environment");
  } finally {
    await rm(directory, { recursive: true });
  }
});
