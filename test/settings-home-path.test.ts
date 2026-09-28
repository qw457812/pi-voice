import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";

test("a saved ~/model path resolves to the current home without changing the file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-home-path-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const path = join(directory, "pi-voice.json");
  const saved = settingsForModel("parakeet-unified-en-0.6b", join("~", ".cache", "model.gguf"));
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`);
  assert.equal((await readSettings()).settings?.model.path, join(homedir(), ".cache", "model.gguf"));
  assert.equal(JSON.parse(await readFile(path, "utf8")).model.path, saved.model.path);

  // Only the path's leading home marker is special; leave other paths alone.
  for (const value of ["~other/model.gguf", "/tmp/model.gguf"]) {
    await writeSettings(settingsForModel("parakeet-unified-en-0.6b", value));
    assert.equal((await readSettings()).settings?.model.path, value);
    assert.equal(JSON.parse(await readFile(path, "utf8")).model.path, value);
  }
});
