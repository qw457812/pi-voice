import type { InputDevice, Permission, Recording } from "@handy-computer/recorder";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import type { Capture, CaptureSinks } from "./dictation-controller.js";
import { logLevel, writeLog } from "./log.js";
import type { MicrophoneSetting } from "./settings.js";
import { MicrophoneUnavailableError } from "./microphone-error.js";
import { getPulseMicrophones, openPulseMicrophone } from "./pulse-audio.js";

export type { InputDevice, Permission };
export { MicrophoneUnavailableError } from "./microphone-error.js";

// Android cannot load handy's native addon. audio.ts itself is loaded on demand.
const desktop = process.platform === "android" ? undefined : await import("@handy-computer/recorder");

// The recorder's own log into Pi Voice's, stamped with when each line was
// written: lines from a blocked event loop arrive late but sort correctly.
const level = logLevel();
if (desktop && level) {
  desktop.setLogHandler(
    (record) => writeLog(record.level === "trace" ? "debug" : record.level, "recorder", record.message, record.timeMs),
    { level: level === "debug" ? "debug" : "info" },
  );
}

/** 32 ms chunks: a power of two, so the meter's FFT uses every sample. */
const FRAMES_PER_CHUNK = 512;

/** Input devices to offer, without PulseAudio monitors of outputs. */
export async function getAvailableMicrophones(): Promise<InputDevice[]> {
  if (process.platform === "android") {
    return (await getPulseMicrophones()).map((name) => ({
      id: name, name, occurrence: 0, backend: "pulseaudio",
      isDefault: false, idIsStable: true, isMonitor: false,
    }));
  }
  return (await desktop!.listInputDevices()).filter((device) => !device.isMonitor);
}

/** A synchronous read that never prompts. */
export function microphonePermission(): Permission {
  return process.platform === "android" ? "unknown" : desktop!.permissionStatus();
}

export function findMicrophone(
  devices: readonly InputDevice[],
  selected: { name: string; occurrence: number },
): InputDevice | undefined {
  return devices.find((device) => device.name === selected.name && device.occurrence === selected.occurrence);
}

function interruption(recording: Recording): Error | undefined {
  const { endReason } = recording;
  if (endReason.kind === "recorderFailed") {
    // Access revoked mid-recording (or refused at the first prompt): what
    // was captured is silence, so fail the take and let the user fix it.
    if (endReason.error.code === "PermissionDenied") throw endReason.error;
    return endReason.error;
  }
  if (endReason.kind === "sinkPanicked") return new Error(endReason.message);
  return undefined;
}

/** Opens the microphone and starts recording 16 kHz mono into `sinks`. */
export async function openMicrophone(microphone: MicrophoneSetting, sinks: CaptureSinks): Promise<Capture> {
  if (process.platform === "android") return openPulseMicrophone(microphone, sinks);
  const { listInputDevices, Recorder } = desktop!;
  let device: InputDevice | undefined;
  if (microphone.type === "device") {
    device = findMicrophone(await listInputDevices(), microphone);
    if (!device) throw new MicrophoneUnavailableError(microphone.name);
  }

  const recorder = await Recorder.open({
    device: device?.id,
    sampleRate: CAPTURE_SAMPLE_RATE,
    channels: "mono",
    framesPerChunk: FRAMES_PER_CHUNK,
    onChunk: ({ samples }) => sinks.onAudio(samples),
    onFailure: (error) => sinks.onFailure(error),
  });
  try {
    const { format } = recorder.info;
    if (format.sampleRate !== CAPTURE_SAMPLE_RATE || format.channels !== 1) {
      throw new Error(`Recorder delivers ${format.sampleRate} Hz × ${format.channels}; expected ${CAPTURE_SAMPLE_RATE} Hz mono`);
    }
    recorder.start();
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }

  return {
    async stop() {
      try {
        const recording = await recorder.stop();
        return {
          pcm: recording.samples,
          interruption: interruption(recording),
          droppedFrames: recording.droppedFrames,
        };
      } finally {
        // The recording is already in hand; a close that times out only
        // means the platform holds the device until Pi exits.
        await recorder.close().catch(() => undefined);
      }
    },
  };
}
