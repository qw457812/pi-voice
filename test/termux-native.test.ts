import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { configureTermuxNative } from "../src/termux-native.js";
import { nativeInstallation } from "../src/termux-native-paths.mjs";

async function isolatedCache(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-native-path-test-"));
  const previousCache = process.env.XDG_CACHE_HOME;
  const previousLibrary = process.env.TRANSCRIBE_LIBRARY;
  process.env.XDG_CACHE_HOME = root;
  delete process.env.TRANSCRIBE_LIBRARY;
  t.after(async () => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    if (previousLibrary === undefined) delete process.env.TRANSCRIBE_LIBRARY;
    else process.env.TRANSCRIBE_LIBRARY = previousLibrary;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("native cache paths are outside the package and keyed by binding version and platform", async (t) => {
  const root = await isolatedCache(t);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "transcribe-cpp", version: "0.2.4" }));
  const bindingEntry = pathToFileURL(join(packageRoot, "dist/index.js")).href;
  const info = nativeInstallation({ bindingEntry, platform: "android", arch: "arm64" });
  assert.equal(info.library, join(root, "pi-voice/native/transcribe-cpp-0.2.4/android-arm64/lib/libtranscribe.so"));
  assert.notEqual(nativeInstallation({ bindingEntry, platform: "android", arch: "x64" }).directory, info.directory);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "transcribe-cpp", version: "0.2.5" }));
  assert.notEqual(nativeInstallation({ bindingEntry, platform: "android", arch: "arm64" }).directory, info.directory);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "transcribe-cpp", version: "../../bad" }));
  assert.throws(() => nativeInstallation({ bindingEntry }), /Cannot determine/);
});

test("Termux resolves the installed version's library without a shell export", async (t) => {
  await isolatedCache(t);
  const { library } = nativeInstallation();
  await mkdir(dirname(library), { recursive: true });
  await writeFile(library, "fixture; never loaded");
  configureTermuxNative("android");
  assert.equal(process.env.TRANSCRIBE_LIBRARY, library);
});

test("a missing native cache gives setup guidance without setting an override", async (t) => {
  await isolatedCache(t);
  assert.throws(() => configureTermuxNative("android"), /npm run termux:setup/);
  assert.equal(process.env.TRANSCRIBE_LIBRARY, undefined);
});

test("explicit native overrides and desktop resolution are left alone", async (t) => {
  await isolatedCache(t);
  configureTermuxNative("linux");
  assert.equal(process.env.TRANSCRIBE_LIBRARY, undefined);
  process.env.TRANSCRIBE_LIBRARY = "/custom/libtranscribe.so";
  configureTermuxNative("android");
  assert.equal(process.env.TRANSCRIBE_LIBRARY, "/custom/libtranscribe.so");
});
