import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeInstallation } from "../src/termux-native-paths.mjs";

if (process.platform !== "android" || process.arch !== "arm64") throw new Error("This smoke check is for Termux Android arm64.");
process.env.TRANSCRIBE_LIBRARY ||= nativeInstallation().library;
const { getAvailableBackends, libraryPath, TranscribeModel, version } = await import("transcribe-cpp");
const require = createRequire(import.meta.resolve("transcribe-cpp"));
const koffi = require("koffi");
const backends = getAvailableBackends(); // Also checks native version and all FFI struct layouts.
assert.ok(backends.some((backend) => backend.deviceType === "cpu"), "No CPU backend found");
console.log({ platform: process.platform, arch: process.arch, koffi: koffi.version, ...version() });
console.log("Library:", libraryPath());
console.log("Backends:", backends.map((backend) => backend.name).join(", "));

// Exercise asynchronous FFI and a native -> JS callback on the worker thread.
// https://koffi.dev/callbacks#asynchronous-callbacks
const libc = koffi.load("libc.so");
const comparatorType = koffi.proto("int PiVoiceCompare(const void *a, const void *b)");
let comparisons = 0;
const comparator = koffi.register((a, b) => {
  comparisons++;
  return koffi.decode(a, "int") - koffi.decode(b, "int");
}, koffi.pointer(comparatorType));
try {
  const qsort = libc.func("void qsort(_Inout_ void *base, size_t count, size_t size, PiVoiceCompare *compare)");
  const data = Int32Array.of(3, -1, 2);
  await new Promise((resolve, reject) => {
    qsort.async(data, data.length, data.BYTES_PER_ELEMENT, comparator, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  assert.deepEqual([...data], [-1, 2, 3]);
  assert.ok(comparisons > 0, "Native callback was not invoked");
} finally {
  koffi.unregister(comparator);
}

const temporary = await mkdtemp(join(tmpdir(), "pi-voice-native-check-"));
try {
  await assert.rejects(TranscribeModel.load(join(temporary, "missing.gguf")));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("Passed: native loading, ABI checks, CPU discovery, async FFI, callbacks, model-load error handling.");
console.log("This is a no-model smoke check, not a transcription or performance test.");
