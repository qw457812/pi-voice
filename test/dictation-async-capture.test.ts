import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel } from "../src/settings.js";
import { FakeMicrophone, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model");

test("asynchronous capture startup does not report listening early", async () => {
  const microphone = new FakeMicrophone();
  microphone.openGate = new Deferred();
  const controller = new DictationController(fakeDictationService(), { openCapture: microphone.open });
  const starting = controller.start(settings);
  await nextTurn();
  assert.equal(controller.state.phase, "starting");
  microphone.openGate.resolve();
  await starting;
  assert.equal(controller.state.phase, "listening");
  await controller.dispose();
});

test("cancelling asynchronous startup stops its capture and ignores late readiness", async () => {
  const service = fakeDictationService();
  const microphone = new FakeMicrophone();
  microphone.openGate = new Deferred();
  const states: DictationState[] = [];
  const controller = new DictationController(service, {
    openCapture: microphone.open,
    onChange: (state) => states.push(state),
  });
  const starting = controller.start(settings);
  await nextTurn();
  const cancellation = controller.cancel();
  microphone.openGate.resolve();
  await Promise.all([starting, cancellation]);
  assert.equal(microphone.captures[0]!.stops, 1);
  assert.equal(states.some((state) => state.phase === "listening"), false);
  assert.equal(controller.state.phase, "idle");
  assert.equal(service.reservations.length, 0);
  await controller.dispose();
});

test("asynchronous startup rejection permits retry without reserving a model", async () => {
  const service = fakeDictationService();
  const microphone = new FakeMicrophone();
  microphone.openError = new Error("source unavailable");
  const controller = new DictationController(service, { openCapture: microphone.open });
  await controller.start(settings);
  assert.equal(controller.state.phase, "error");
  assert.equal(service.reservations.length, 0);
  microphone.openError = undefined;
  await controller.start(settings);
  assert.equal(controller.state.phase, "listening");
  await controller.dispose();
  assert.equal(microphone.captures[0]!.stops, 1);
});

test("PCM drained during stop is fed before the final streaming tail is flushed", async () => {
  const service = fakeDictationService();
  const microphone = new FakeMicrophone();
  const controller = new DictationController(service, { openCapture: microphone.open });
  await controller.start(settings);
  const capture = microphone.captures[0]!;
  const gate = new Deferred<{ pcm: Float32Array }>();
  capture.stopGate = gate;
  capture.feed(Float32Array.of(100 / 32768));
  const submission = controller.stop();
  capture.feed(Float32Array.of(200 / 32768));
  gate.resolve({ pcm: Float32Array.of(100 / 32768, 200 / 32768) });
  await nextTurn();
  const reservation = service.reservations[0]!;
  assert.deepEqual(reservation.chunks.map((chunk) => [...chunk]), [[100 / 32768, 200 / 32768]]);
  reservation.result.resolve("drained");
  assert.equal((await submission)?.text, "drained");
  await controller.dispose();
});
