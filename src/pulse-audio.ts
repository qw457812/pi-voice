import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { Deferred } from "./deferred.js";
import type { DictationCapture } from "./dictation-controller.js";
import { convertFrames } from "./pcm.js";
import { parsePulseMicrophones, selectPulseMicrophone, SETUP_HELP } from "./pulse-sources.js";
import type { MicrophoneSetting } from "./settings.js";

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_STDERR_CHARS = 8 * 1024;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function pactl(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pactl", args, {
      timeout: START_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Could not query PulseAudio: ${toError(error).message.slice(-MAX_STDERR_CHARS)}. ${SETUP_HELP}`);
  }
}

export async function getPulseMicrophones(signal?: AbortSignal): Promise<string[]> {
  return parsePulseMicrophones(await pactl(["--format=json", "list", "sources"], signal));
}

async function selectSource(microphone: MicrophoneSetting, signal: AbortSignal): Promise<string> {
  const sources = await getPulseMicrophones(signal);
  // Explicit selections and empty lists never need a default-source query.
  const defaultSource = microphone.type === "system-default" && sources.length > 0
    ? await pactl(["get-default-source"], signal)
    : undefined;
  return selectPulseMicrophone(sources, microphone, defaultSource);
}

type CaptureRun = {
  ready: Deferred;
  closed: Deferred;
  abort: AbortController;
  frames: Int16Array[];
  pending: Buffer;
  stderr: string;
  stopping: boolean;
  child?: ChildProcess;
  error?: Error;
  startTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  stopResult?: Promise<{ pcm: Float32Array }>;
};

/** Termux's parec client supplies resampled PCM without a Node native addon. */
export class PulseAudioCapture implements DictationCapture {
  private run: CaptureRun | undefined;
  onFrame?: (frame: Int16Array) => void;

  constructor(private readonly microphone: MicrophoneSetting) {}

  async start(): Promise<void> {
    if (this.run) throw new Error("Microphone capture is already active");
    const run: CaptureRun = {
      ready: new Deferred(), closed: new Deferred(), abort: new AbortController(),
      frames: [], pending: Buffer.alloc(0), stderr: "", stopping: false,
    };
    this.run = run;
    try {
      const source = await selectSource(this.microphone, run.abort.signal);
      run.abort.signal.throwIfAborted();
      const child = spawn("parec", [
        `--device=${source}`, "--raw", "--format=s16le",
        `--rate=${CAPTURE_SAMPLE_RATE}`, "--channels=1", "--latency-msec=32",
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      run.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.receive(run, chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        run.stderr = (run.stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
      });
      child.once("error", (error) => {
        run.error ??= new Error(`Could not run parec: ${error.message}. ${SETUP_HELP}`);
        run.ready.reject(run.error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(run.startTimer);
        clearTimeout(run.stopTimer);
        if (!run.stopping || (code !== 0 && signal !== "SIGTERM")) {
          run.error ??= new Error(`PulseAudio recording ended unexpectedly (${signal ?? code}): ${run.stderr.trim() || "no diagnostic output"}. ${SETUP_HELP}`);
        }
        if (run.pending.length) run.error ??= new Error("parec returned an incomplete Int16 PCM sample");
        // A normal stop after the first PCM sample must not change startup's outcome.
        if (!run.ready.settled) {
          run.ready.reject(run.error ?? new Error("Recording stopped before any audio arrived"));
        }
        run.closed.resolve();
      });
      run.startTimer = setTimeout(() => {
        run.error = new Error(`No audio arrived from PulseAudio within 5 seconds. Keep Termux in the foreground and check Android microphone permission. ${SETUP_HELP}`);
        run.ready.reject(run.error);
        this.terminate(run);
      }, START_TIMEOUT_MS);
      // Do not show "listening" just because spawn succeeded: wait for PCM.
      await run.ready.promise;
    } catch (error) {
      run.error ??= toError(error);
      if (run.child) {
        this.terminate(run);
        await run.closed.promise;
      } else {
        run.closed.resolve();
      }
      throw run.error;
    }
  }

  stop(): Promise<{ pcm: Float32Array }> {
    const run = this.run;
    if (!run) return Promise.reject(new Error("Microphone capture is not active"));
    if (run.stopResult) return run.stopResult;
    run.stopping = true;
    run.abort.abort(); // Also cancels an in-flight pactl query during startup.
    this.terminate(run);
    run.stopResult = run.closed.promise.then(() => {
      if (run.error) throw run.error;
      if (run.frames.length === 0) throw new Error("No audio samples were captured");
      return { pcm: convertFrames(run.frames) };
    }).finally(() => {
      if (this.run === run) this.run = undefined;
    });
    return run.stopResult;
  }

  private terminate(run: CaptureRun): void {
    if (!run.child || run.closed.settled || run.stopTimer) return;
    run.child.kill("SIGTERM");
    run.stopTimer = setTimeout(() => {
      run.error ??= new Error("parec did not stop within 2 seconds; terminated it forcibly");
      run.child?.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    run.stopTimer.unref();
  }

  private receive(run: CaptureRun, chunk: Buffer): void {
    if (run.error) return;
    const bytes = run.pending.length ? Buffer.concat([run.pending, chunk]) : chunk;
    const completeBytes = bytes.length - bytes.length % Int16Array.BYTES_PER_ELEMENT;
    run.pending = Buffer.from(bytes.subarray(completeBytes));
    if (completeBytes === 0) return;
    // Pipe reads need not align with samples, and each frame must own its data.
    const frame = new Int16Array(completeBytes / Int16Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < frame.length; index++) frame[index] = bytes.readInt16LE(index * 2);
    run.frames.push(frame);
    clearTimeout(run.startTimer);
    run.ready.resolve();
    try { this.onFrame?.(frame); } catch { /* Presentation must not break audio capture. */ }
  }
}
