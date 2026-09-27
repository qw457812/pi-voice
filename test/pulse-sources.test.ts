import assert from "node:assert/strict";
import { test } from "node:test";
import { MicrophoneUnavailableError } from "../src/microphone-error.js";
import { parsePulseMicrophones, selectPulseMicrophone, SETUP_HELP } from "../src/pulse-sources.js";
import type { MicrophoneSetting } from "../src/settings.js";

const defaultMicrophone: MicrophoneSetting = { type: "system-default" };
const inputs = Object.freeze(["built-in", "usb-mic"]);

test("source parsing excludes each monitor form and preserves microphone order", () => {
  const output = JSON.stringify([
    { name: "built-in", monitor_source: "", properties: { "device.class": "abstract" } },
    { name: "speaker.monitor" },
    { name: "custom-monitor", monitor_source: "speaker" },
    { name: "another-monitor", properties: { "device.class": "monitor" } },
    { name: "usb-mic" },
  ]);
  assert.deepEqual(parsePulseMicrophones(output), inputs);
});

test("source parsing ignores entries without string names and allows empty lists", () => {
  const output = JSON.stringify([null, false, 123, "not a source", {}, { name: 42 }, { name: "mic" }]);
  assert.deepEqual(parsePulseMicrophones(output), ["mic"]);
  assert.deepEqual(parsePulseMicrophones("[]"), []);
});

test("source parsing rejects malformed JSON and non-array lists", () => {
  assert.throws(() => parsePulseMicrophones("{"), SyntaxError);
  for (const output of ["null", "{}", "42", '"mic"']) {
    assert.throws(() => parsePulseMicrophones(output), {
      message: "PulseAudio returned an invalid source list.",
    });
  }
});

test("explicit source selection takes precedence over the default", () => {
  const selected: MicrophoneSetting = { type: "device", name: "usb-mic", occurrence: 0 };
  assert.equal(selectPulseMicrophone(inputs, selected, "built-in"), "usb-mic");
  assert.equal(selectPulseMicrophone(inputs, selected), "usb-mic");
});

test("missing explicit sources and nonzero occurrences never fall back", () => {
  for (const selected of [
    { type: "device", name: "missing", occurrence: 0 },
    { type: "device", name: "usb-mic", occurrence: 1 },
    { type: "device", name: "usb-mic", occurrence: -1 },
  ] as const) {
    assert.throws(() => selectPulseMicrophone(inputs, selected, "built-in"), MicrophoneUnavailableError);
  }
  assert.throws(() => selectPulseMicrophone([], {
    type: "device", name: "missing", occurrence: 0,
  }), MicrophoneUnavailableError);
});

test("default selection rejects empty microphone lists with setup guidance", () => {
  assert.throws(() => selectPulseMicrophone([], defaultMicrophone, "speaker.monitor"), {
    message: `PulseAudio has no microphone source. ${SETUP_HELP}`,
  });
});

test("default selection follows a real input and trims pactl output", () => {
  assert.equal(selectPulseMicrophone(inputs, defaultMicrophone, "usb-mic\n"), "usb-mic");
  assert.equal(selectPulseMicrophone(inputs, defaultMicrophone, "  built-in\n"), "built-in");
});

test("default selection falls back to the sole microphone", () => {
  for (const defaultSource of ["speaker.monitor", "missing", "", undefined]) {
    assert.equal(selectPulseMicrophone(["built-in"], defaultMicrophone, defaultSource), "built-in");
  }
});

test("default selection rejects ambiguous inputs without a matching default", () => {
  for (const defaultSource of ["speaker.monitor", "missing", "", undefined]) {
    assert.throws(() => selectPulseMicrophone(inputs, defaultMicrophone, defaultSource), {
      message: "The default PulseAudio source is not a microphone. Open /voice-settings and choose an input.",
    });
  }
});
