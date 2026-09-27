import { MicrophoneUnavailableError } from "./microphone-error.js";
import type { MicrophoneSetting } from "./settings.js";

export const SETUP_HELP = "In Termux, install pulseaudio, run pulseaudio --start, and load module-sles-source with pactl after granting microphone permission via Termux:API. See docs/termux.md.";

/** Parse pactl's source list, excluding speaker monitors and unnamed entries. */
export function parsePulseMicrophones(output: string): string[] {
  const sources: unknown = JSON.parse(output);
  if (!Array.isArray(sources)) throw new Error("PulseAudio returned an invalid source list.");
  return sources.filter((source) =>
    source && typeof source.name === "string" &&
    !source.name.endsWith(".monitor") && !source.monitor_source &&
    source.properties?.["device.class"] !== "monitor",
  ).map((source) => source.name as string);
}

/** Choose from microphone names; defaultSource is optional pactl output. */
export function selectPulseMicrophone(
  sources: readonly string[],
  microphone: MicrophoneSetting,
  defaultSource?: string,
): string {
  if (microphone.type === "device") {
    if (microphone.occurrence !== 0 || !sources.includes(microphone.name)) {
      throw new MicrophoneUnavailableError(microphone.name);
    }
    return microphone.name;
  }
  if (sources.length === 0) throw new Error(`PulseAudio has no microphone source. ${SETUP_HELP}`);
  const preferred = defaultSource?.trim();
  if (preferred !== undefined && sources.includes(preferred)) return preferred;
  // Termux may default to the speaker monitor even with one real input loaded.
  if (sources.length === 1) return sources[0]!;
  throw new Error("The default PulseAudio source is not a microphone. Open /voice-settings and choose an input.");
}
