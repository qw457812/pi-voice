import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Deferred } from "../src/deferred.js";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { createPiVoiceRuntime } from "../src/runtime.js";
import { settingsForModel, writeSettings } from "../src/settings.js";
import { testTheme } from "./ui-helpers.js";

test("the runtime cancel key interrupts microphone startup and removes its listener", {
  // This test must not invoke the separate macOS system permission probe.
  skip: process.platform === "darwin",
  timeout: 10_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-runtime-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const model = join(directory, "unused-model");
  await writeFile(model, "test fixture; never loaded");
  await writeSettings(settingsForModel("parakeet-unified-en-0.6b", model));

  const entered = new Deferred();
  const ready = new Deferred();
  let phase: DictationState["phase"] = "idle";
  let cancellations = 0;
  t.mock.getter(DictationController.prototype, "state", () => ({ phase }));
  t.mock.method(DictationController.prototype, "start", () => {
    phase = "starting";
    entered.resolve();
    return ready.promise;
  });
  t.mock.method(DictationController.prototype, "cancel", async () => {
    cancellations++;
    phase = "idle";
    ready.resolve();
  });

  type InputListener = Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0];
  let listener: InputListener | undefined;
  const messages: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: testTheme(),
      notify: (message: string) => messages.push(message),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      pasteToEditor: () => assert.fail("A cancelled startup must not insert text"),
      onTerminalInput: (handler: InputListener) => {
        listener = handler;
        return () => { listener = undefined; };
      },
    },
  } as unknown as ExtensionContext;
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, "ctrl+alt+z");
  const starting = runtime.toggleCapture(ctx);
  // Let cleanup finish even if an assertion catches a missing cancel listener.
  t.after(async () => {
    ready.resolve();
    await starting;
    await runtime.shutdown(ctx);
  });
  await entered.promise;
  assert.ok(listener, "Cancel listener must exist before microphone startup finishes");
  assert.deepEqual(await listener("\x1b"), { consume: true });
  await starting;
  assert.ok(cancellations > 0);
  assert.deepEqual(messages, ["Recording cancelled"]);
  assert.equal(listener, undefined);
  assert.ok(widgets.some((lines) => lines?.some((line) => line.includes("Starting microphone") && line.includes("escape"))));
  assert.equal(widgets.at(-1), undefined);
});
