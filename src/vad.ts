import { fileURLToPath } from "node:url";
import type { TranscribeModel } from "transcribe-cpp";
import { CAPTURE_CHUNK_SAMPLES, CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { getCatalogModel } from "./catalog.js";
import type { SpeechFilter } from "./dictation-controller.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";
import { loadTranscribeCpp } from "./termux-native.js";
import { routeTranscribeLog } from "./transcribe-log.js";

// Constants come from Handy (cjpais/handy, src-tauri/src/audio_toolkit/vad).
// It's SmoothedVad idea to improve basic VAD performance
const THRESHOLD = 0.3;
const PREFILL_MS = 450;
const ONSET_MS = 60;
const OFFLINE_HANGOVER_MS = 450;
const STREAMING_HANGOVER_MS = 1650;
const MODEL_PATH = fileURLToPath(new URL("../models/silero-vad-v6.2-F32.gguf", import.meta.url));

function framesFor(durationMs: number): number {
  return Math.ceil((durationMs * CAPTURE_SAMPLE_RATE) / (CAPTURE_CHUNK_SAMPLES * 1000));
}

function concat(pieces: readonly Float32Array[]): Float32Array {
  if (pieces.length === 1) return pieces[0]!;
  const out = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

type BufferedFrame = { samples: Float32Array; emitted: boolean };

// Handy's SmoothedVad
export class SpeechGate {
  private readonly buffer: BufferedFrame[] = [];
  private hangover = 0;
  private onset = 0;
  private speaking = false;

  constructor(private readonly options: { prefillFrames: number; onsetFrames: number; hangoverFrames: number }) {}

  get inSpeech(): boolean { return this.speaking; }

  /** The frames to keep now, in order. */
  push(samples: Float32Array, voiced: boolean): Float32Array[] {
    const frame: BufferedFrame = { samples, emitted: false };
    this.buffer.push(frame);
    while (this.buffer.length > this.options.prefillFrames + 1) this.buffer.shift();

    if (!this.speaking) {
      if (!voiced) {
        this.onset = 0;
        return [];
      }
      if (++this.onset < this.options.onsetFrames) return [];
      this.speaking = true;
      this.onset = 0;
      this.hangover = this.options.hangoverFrames;
      return this.takeWithheld();
    }

    if (voiced) this.hangover = this.options.hangoverFrames;
    else if (this.hangover > 0) this.hangover--;
    else {
      this.speaking = false;
      return [];
    }
    frame.emitted = true;
    return [samples];
  }

  takeWithheld(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const frame of this.buffer) {
      if (frame.emitted) continue;
      frame.emitted = true;
      out.push(frame.samples);
    }
    return out;
  }

  finish(): Float32Array[] {
    return this.onset > 0 ? this.takeWithheld() : [];
  }
}

export type VadScorer = {
  score(frame: Float32Array): Promise<number>;
  dispose(): void;
};

type VoiceActivityFilterOptions = {
  /** Opened on the first audio. */
  openScorer: () => Promise<VadScorer>;
  /** Receives kept audio, in order, as soon as it is decided. */
  onSpeech: (chunk: Float32Array) => void;
  hangoverMs: number;
};

/**
 * One recording's VAD. Each pushed chunk is one frame; scoring is async, so
 * frames queue and are decided in order. If the detector fails, nothing not
 * yet dropped is lost and the rest of the recording passes through.
 */
export class VoiceActivityFilter implements SpeechFilter {
  private readonly gate: SpeechGate;
  private readonly pending: Float32Array[] = [];
  private readonly kept: Float32Array[] = [];
  private recordedSamples = 0;
  private scorer: VadScorer | undefined;
  private running: Promise<void> | undefined;
  private failed = false;
  private finishing = false;
  private discarded = false;

  constructor(private readonly options: VoiceActivityFilterOptions) {
    this.gate = new SpeechGate({
      prefillFrames: framesFor(PREFILL_MS),
      onsetFrames: framesFor(ONSET_MS),
      hangoverFrames: framesFor(options.hangoverMs),
    });
  }

  push(chunk: Float32Array): void {
    if (this.finishing || this.discarded) return;
    this.pending.push(chunk);
    this.kick();
  }

  async finish(): Promise<Float32Array> {
    this.finishing = true;
    while (this.running) await this.running;
    if (this.discarded) return new Float32Array();
    if (!this.failed) this.keep(this.gate.finish());
    this.release();
    const kept = concat(this.kept);
    log.info(this.failed
      ? "voice activity detection unavailable; kept the whole recording"
      : `voice activity: kept ${(kept.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of ${(this.recordedSamples / CAPTURE_SAMPLE_RATE).toFixed(1)} s`);
    return kept;
  }

  discard(): void {
    if (this.discarded) return;
    this.discarded = true;
    this.pending.length = 0;
    // A score may be in flight; free the session once the loop has stopped.
    if (this.running) void this.running.then(() => this.release());
    else this.release();
  }

  private kick(): void {
    if (this.running || this.discarded || this.pending.length === 0) return;
    const running = this.drain().catch((error: unknown) => this.fail(error)).finally(() => {
      if (this.running === running) this.running = undefined;
      this.kick();
    });
    this.running = running;
  }

  private async drain(): Promise<void> {
    if (!this.scorer && !this.failed) {
      try {
        this.scorer = await this.options.openScorer();
      } catch (error) {
        this.fail(error);
      }
      if (this.discarded) return;
    }
    while (this.pending.length > 0 && !this.discarded) {
      const frame = this.pending.shift()!;
      this.recordedSamples += frame.length;
      if (this.failed) {
        this.keep([frame]);
        continue;
      }
      // Only a recording's last chunk is short; it follows the current decision.
      if (frame.length < CAPTURE_CHUNK_SAMPLES) {
        if (this.gate.inSpeech) this.keep([frame]);
        continue;
      }
      let probability: number;
      try {
        probability = await this.scorer!.score(frame);
      } catch (error) {
        this.fail(error);
        this.keep([frame]);
        continue;
      }
      if (this.discarded) return;
      this.keep(this.gate.push(frame, probability > THRESHOLD));
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    log.warn(`voice activity detection unavailable, keeping all audio: ${describeError(error)}`);
    this.keep(this.gate.takeWithheld());
    this.release();
  }

  private keep(frames: Float32Array[]): void {
    if (frames.length === 0 || this.discarded) return;
    const chunk = concat(frames);
    this.kept.push(chunk);
    try { this.options.onSpeech(chunk); } catch { /* Still in the final transcript. */ }
  }

  private release(): void {
    this.scorer?.dispose();
    this.scorer = undefined;
  }
}

/** Loads the bundled Silero model on first use and keeps it across recordings. */
export class VoiceActivityDetection {
  private model: Promise<TranscribeModel> | undefined;
  private disposed = false;

  /** Undefined when the setting is off. */
  createFilter(settings: TranscribeSettings, onSpeech: (chunk: Float32Array) => void): SpeechFilter | undefined {
    if (!settings.voiceActivityDetection || this.disposed) return undefined;
    const streaming = getCatalogModel(settings.model.id)?.capabilities.streaming ?? false;
    return new VoiceActivityFilter({
      openScorer: () => this.openScorer(),
      onSpeech,
      hangoverMs: streaming ? STREAMING_HANGOVER_MS : OFFLINE_HANGOVER_MS,
    });
  }

  private async openScorer(): Promise<VadScorer> {
    if (this.disposed) throw new Error("Pi Voice is shutting down");
    // A failed load is retried by the next recording.
    const loading = (this.model ??= loadModel().catch((error: unknown) => {
      this.model = undefined;
      throw error;
    }));
    const model = await loading;
    if (this.disposed) throw new Error("Pi Voice is shutting down");
    const session = model.createVadSession({ nThreads: 1 });
    return {
      async score(frame) {
        const { probs } = await session.streamFeed(frame);
        if (probs.length !== 1) throw new Error(`Silero VAD returned ${probs.length} probabilities for one frame`);
        return probs[0]!;
      },
      dispose: () => session.dispose(),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const model = await this.model?.catch(() => undefined);
    this.model = undefined;
    model?.dispose();
  }
}

async function loadModel(): Promise<TranscribeModel> {
  // Route native logs into Pi Voice's log before the first native call.
  const { TranscribeModel, setLogHandler } = await loadTranscribeCpp();
  routeTranscribeLog(setLogHandler);
  return TranscribeModel.load(MODEL_PATH);
}
