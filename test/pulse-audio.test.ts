import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getPulseMicrophones, openPulseMicrophone, PulseAudioCapture } from "../src/pulse-audio.js";
import type { MicrophoneSetting } from "../src/settings.js";

const defaultMicrophone: MicrophoneSetting = { type: "system-default" };
const input = { name: "OpenSL_ES_source", monitor_source: "", properties: { "device.class": "abstract" } };
const monitor = { name: "output.monitor", monitor_source: "output", properties: { "device.class": "monitor" } };
const samples = [-32768, -1000, 0, 1000, 32767];
const unixOnly = { skip: process.platform === "win32" };

type FixtureOptions = {
  samples?: number[];
  sources?: unknown;
  defaultSource?: string;
  queryError?: boolean;
  defaultQueryError?: boolean;
  slowQuery?: boolean;
  mode?: "record" | "error" | "no-audio" | "odd" | "exit" | "ignore-stop";
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-pulse-test-"));
  const oldPath = process.env.PATH;
  // Isolate PATH entirely, so a missing fixture can NEVER fall through to a real mic.
  process.env.PATH = directory;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  const calls = join(directory, "parec-args.json");
  const configuration = {
    sources: [monitor, input], defaultSource: input.name, samples,
    ...options, calls,
  };
  const preamble = `#!${process.execPath}\nconst fs = require("node:fs");\nconst config = ${JSON.stringify(configuration)};\n`;
  await writeFile(join(directory, "pactl"), preamble + `
if (config.queryError || (config.defaultQueryError && process.argv[2] === "get-default-source")) {
  console.error("Connection refused"); process.exit(1);
}
const output = () => console.log(process.argv[2] === "get-default-source"
  ? config.defaultSource : JSON.stringify(config.sources));
if (config.slowQuery) setTimeout(output, 60000);
else output();
`);
  await writeFile(join(directory, "parec"), preamble + `
fs.writeFileSync(config.calls, JSON.stringify(process.argv.slice(2)));
if (config.mode === "error") { console.error("Access denied"); process.exit(1); }
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  if (config.mode === "ignore-stop") return;
  clearInterval(timer);
  const tail = Buffer.alloc(config.mode === "odd" ? 1 : 2);
  if (tail.length === 2) tail.writeInt16LE(1234);
  process.stdout.write(tail, () => process.exit(0));
});
if (config.mode !== "no-audio") {
  const pcm = Buffer.alloc(config.samples.length * 2);
  config.samples.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  // Deliberately split samples across pipe writes.
  process.stdout.write(pcm.subarray(0, 1));
  setTimeout(() => process.stdout.write(pcm.subarray(1, 4)), 10);
  setTimeout(() => process.stdout.write(pcm.subarray(4), () => {
    if (config.mode === "exit") process.exit(0);
  }), 20);
}
`);
  await Promise.all(["pactl", "parec"].map((name) => chmod(join(directory, name), 0o700)));
  const capture = new PulseAudioCapture(defaultMicrophone);
  t.after(() => capture.stop().catch(() => {}));
  return { directory, calls, capture };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the fake audio process");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("PulseAudio enumerates inputs but not speaker monitors", unixOnly, async (t) => {
  await fixture(t, { sources: [monitor, input, { ...monitor, name: "custom-monitor-name" }] });
  assert.deepEqual(await getPulseMicrophones(), [input.name]);
});

test("PulseAudio errors are actionable and malformed source lists are rejected", unixOnly, async (t) => {
  const { directory } = await fixture(t, { queryError: true });
  await assert.rejects(getPulseMicrophones(), /Connection refused.*pulseaudio/s);
  await rm(join(directory, "pactl"));
  await assert.rejects(getPulseMicrophones(), /Could not query PulseAudio.*pulseaudio/s);
});

test("PulseAudio rejects non-array JSON source lists", unixOnly, async (t) => {
  await fixture(t, { sources: {} });
  await assert.rejects(getPulseMicrophones(), /invalid source list/);
});

test("PCM pipe fragments, final samples, resampling options and stop are handled", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, { defaultSource: monitor.name });
  const received: number[] = [];
  capture.onAudio = (frame) => { received.push(...frame); };
  await capture.start();
  await waitFor(() => received.length === samples.length);
  const stopping = capture.stop();
  assert.equal(capture.stop(), stopping);
  const { pcm } = await stopping;
  assert.deepEqual(received, [...samples, 1234].map((sample) => sample / 32768));
  assert.deepEqual([...pcm], received);
  assert.deepEqual(JSON.parse(await readFile(calls, "utf8")), [
    `--device=${input.name}`, "--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=32",
  ]);
});

test("no input, unavailable selections and ambiguous defaults never open a recorder", unixOnly, async (t) => {
  const { calls } = await fixture(t, { sources: [monitor] });
  const capture = new PulseAudioCapture(defaultMicrophone);
  await assert.rejects(capture.start(), /no microphone source/);
  await assert.rejects(capture.stop(), /no microphone source/);
  const selected = new PulseAudioCapture({ type: "device", name: "gone", occurrence: 0 });
  await assert.rejects(selected.start(), { name: "MicrophoneUnavailableError" });
  await assert.rejects(selected.stop(), { name: "MicrophoneUnavailableError" });
  assert.equal(existsSync(calls), false);
});

test("multiple inputs never silently select a speaker monitor", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, {
    sources: [monitor, input, { ...input, name: "other-input" }], defaultSource: monitor.name,
  });
  await assert.rejects(capture.start(), /choose an input/);
  assert.equal(existsSync(calls), false);
});

test("explicit selections do not query the PulseAudio default", unixOnly, async (t) => {
  await fixture(t, { defaultQueryError: true });
  const capture = new PulseAudioCapture({ type: "device", name: input.name, occurrence: 0 });
  t.after(() => capture.stop().catch(() => {}));
  await capture.start();
  await capture.stop();
});

test("empty input lists do not query the PulseAudio default", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, { sources: [], defaultQueryError: true });
  await assert.rejects(capture.start(), /no microphone source/);
  assert.equal(existsSync(calls), false);
});

test("default query errors are not bypassed even for a sole microphone", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, { sources: [input], defaultQueryError: true });
  await assert.rejects(capture.start(), /Could not query PulseAudio.*Connection refused/s);
  assert.equal(existsSync(calls), false);
});

test("selected PulseAudio source is used instead of the default", unixOnly, async (t) => {
  const { calls } = await fixture(t, { sources: [input, { ...input, name: "other-input" }] });
  const capture = new PulseAudioCapture({ type: "device", name: "other-input", occurrence: 0 });
  t.after(() => capture.stop().catch(() => {}));
  await capture.start();
  assert.equal(JSON.parse(await readFile(calls, "utf8"))[0], "--device=other-input");
  await capture.stop();
});

test("capture reports startup failures and can be stopped after a missing executable", unixOnly, async (t) => {
  const { capture, directory } = await fixture(t, { mode: "error" });
  await assert.rejects(capture.start(), /Access denied/);
  await assert.rejects(capture.stop(), /Access denied/);
  await rm(join(directory, "parec"));
  await assert.rejects(capture.start(), /Could not run parec/);
  await assert.rejects(capture.stop(), /Could not run parec/);
});

test("cancellation interrupts source discovery without spawning a recorder", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, { slowQuery: true });
  const starting = assert.rejects(capture.start());
  await assert.rejects(capture.stop());
  await starting;
  assert.equal(existsSync(calls), false);
});

test("cancellation also works while waiting for the first PCM sample", unixOnly, async (t) => {
  const { capture, calls } = await fixture(t, { mode: "no-audio" });
  const starting = capture.start().catch(() => {});
  await waitFor(() => existsSync(calls));
  await capture.stop().catch(() => {});
  await starting;
});

test("incomplete samples retain captured audio with an interruption", unixOnly, async (t) => {
  const { capture } = await fixture(t, { mode: "odd" });
  let count = 0;
  capture.onAudio = (frame) => { count += frame.length; };
  await capture.start();
  await waitFor(() => count === samples.length);
  const result = await capture.stop();
  assert.match(result.interruption!.message, /incomplete Int16/);
  assert.equal(result.pcm.length, samples.length);
});

test("an unexpected recorder exit is reported even after startup succeeded", unixOnly, async (t) => {
  const { capture } = await fixture(t, { mode: "exit" });
  const failures: Error[] = [];
  capture.onFailure = (error) => failures.push(error);
  await capture.start();
  await waitFor(() => failures.length > 0);
  const result = await capture.stop();
  assert.match(result.interruption!.message, /ended unexpectedly/);
  assert.deepEqual(failures, [result.interruption]);
});

test("unresponsive recorders are killed rather than hanging shutdown", unixOnly, async (t) => {
  const { capture } = await fixture(t, { mode: "ignore-stop" });
  await capture.start();
  assert.match((await capture.stop()).interruption!.message, /terminated it forcibly/);
});

test("missing PCM times out without claiming to be listening", unixOnly, async (t) => {
  const { capture } = await fixture(t, { mode: "no-audio" });
  await assert.rejects(capture.start(), /No audio arrived/);
  await assert.rejects(capture.stop(), /No audio arrived/);
});

test("Android audio factory does not import the unsupported native recorder", {
  skip: process.platform !== "android",
}, async (t) => {
  const inputSamples = Array.from({ length: 1025 }, (_, index) => index - 512);
  await fixture(t, { samples: inputSamples });
  const { microphonePermission, getAvailableMicrophones, openMicrophone } = await import("../src/audio.js");
  assert.equal(microphonePermission(), "unknown");
  const devices = await getAvailableMicrophones();
  assert.deepEqual(devices.map(({ name, occurrence, isMonitor }) => ({ name, occurrence, isMonitor })), [
    { name: input.name, occurrence: 0, isMonitor: false },
  ]);
  const audio: number[] = [];
  const capture = await openMicrophone({ type: "device", name: devices[0]!.name, occurrence: 0 }, {
    onAudio: (chunk) => audio.push(...chunk),
    onFailure: (error) => assert.fail(error.message),
  });
  t.after(() => capture.stop().catch(() => undefined));
  await waitFor(() => audio.length === 1024);
  const { pcm } = await capture.stop();
  assert.deepEqual([...pcm], [...inputSamples, 1234].map((sample) => sample / 32768));
  assert.deepEqual(audio, [...pcm]);
});

test("PulseAudio factory emits fixed VAD frames and flushes the final partial frame", unixOnly, async (t) => {
  const inputSamples = Array.from({ length: 1025 }, (_, index) => index - 512);
  await fixture(t, { samples: inputSamples });
  const frames: Float32Array[] = [];
  const capture = await openPulseMicrophone(defaultMicrophone, {
    onAudio: (frame) => frames.push(frame),
    onFailure: (error) => assert.fail(error.message),
  });
  t.after(() => capture.stop().catch(() => undefined));
  await waitFor(() => frames.length === 2);
  assert.deepEqual(frames.map((frame) => frame.length), [512, 512]);
  const stopping = capture.stop();
  assert.equal(capture.stop(), stopping);
  const { pcm } = await stopping;
  assert.deepEqual(frames.map((frame) => frame.length), [512, 512, 2]);
  const expected = [...inputSamples, 1234].map((sample) => sample / 32768);
  assert.deepEqual(frames.flatMap((frame) => [...frame]), expected);
  assert.deepEqual([...pcm], expected);
});

test("OpenCapture cleans up failed startup and allows another opening", unixOnly, async (t) => {
  const { directory } = await fixture(t, { mode: "error" });
  const sinks = { onAudio() {}, onFailure() {} };
  await assert.rejects(openPulseMicrophone(defaultMicrophone, sinks), /Access denied/);
  await rm(join(directory, "parec"));
  await assert.rejects(openPulseMicrophone(defaultMicrophone, sinks), /Could not run parec/);
});
