import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel } from "../src/settings.js";
import { FakeCapture, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model");

test("asynchronous capture startup does not report listening early", async () => {
  const service = fakeDictationService();
  const gate = new Deferred();
  const capture = new FakeCapture();
  const controller = new DictationController(service, {
    createCapture: () => ({
      start: () => gate.promise,
      stop: () => capture.stop(),
    }),
  });
  const starting = controller.start(settings);
  await nextTurn();
  assert.equal(controller.state.phase, "starting");
  gate.resolve();
  await starting;
  assert.equal(controller.state.phase, "listening");
  await controller.dispose();
});

test("cancelling asynchronous startup stops its capture and ignores late readiness", async () => {
  const service = fakeDictationService();
  const gate = new Deferred();
  const states: DictationState[] = [];
  let stops = 0;
  const controller = new DictationController(service, {
    createCapture: () => ({
      start: () => gate.promise,
      async stop() {
        stops++;
        gate.resolve();
        return { pcm: new Float32Array() };
      },
    }),
    onChange: (state) => states.push(state),
  });
  const starting = controller.start(settings);
  await nextTurn();
  await controller.cancel();
  await starting;
  assert.equal(stops, 1);
  assert.equal(states.some((state) => state.phase === "listening"), false);
  assert.equal(controller.state.phase, "idle");
  assert.equal(service.reservations[0]!.submissions, 0);
  await controller.dispose();
});

test("asynchronous startup rejection releases the capture and permits retry", async () => {
  const service = fakeDictationService();
  let fail = true;
  let stops = 0;
  const controller = new DictationController(service, {
    createCapture: () => ({
      async start() { if (fail) throw new Error("source unavailable"); },
      async stop() { stops++; return { pcm: new Float32Array() }; },
    }),
  });
  await controller.start(settings);
  assert.equal(controller.state.phase, "error");
  assert.equal(stops, 1);
  fail = false;
  await controller.start(settings);
  assert.equal(controller.state.phase, "listening");
  await controller.dispose();
  assert.equal(stops, 2);
});

test("PCM drained during stop is fed before the final streaming tail is flushed", async () => {
  const service = fakeDictationService();
  const capture = new FakeCapture();
  const gate = new Deferred<{ pcm: Float32Array }>();
  capture.stopGate = gate;
  const controller = new DictationController(service, { createCapture: () => capture });
  await controller.start(settings);
  capture.onFrame!(Int16Array.of(100));
  const submission = controller.stop();
  capture.onFrame!(Int16Array.of(200));
  gate.resolve({ pcm: Float32Array.of(100 / 32768, 200 / 32768) });
  await nextTurn();
  const reservation = service.reservations[0]!;
  assert.deepEqual(reservation.chunks.map((chunk) => [...chunk]), [[100 / 32768, 200 / 32768]]);
  assert.equal(capture.onFrame, undefined);
  reservation.result.resolve("drained");
  assert.equal((await submission)?.text, "drained");
  await controller.dispose();
});
