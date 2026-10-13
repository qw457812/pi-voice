import { writeLog, type LogLevel } from "./log.js";

// transcribe-cpp info is verbose GPU setup; route it to debug.
const TRANSCRIBE_LEVELS: Record<number, LogLevel> = { 1: "debug", 2: "warn", 3: "error", 4: "debug" };
const TRANSCRIBE_CONTINUATION = 5;
let lastTranscribeLevel: LogLevel = "debug";

export function routeTranscribeLog(setLogHandler: typeof import("transcribe-cpp").setLogHandler): void {
  setLogHandler((level, message) => {
    if (level !== TRANSCRIBE_CONTINUATION) lastTranscribeLevel = TRANSCRIBE_LEVELS[level] ?? "debug";
    writeLog(lastTranscribeLevel, "transcribe", message);
  });
}
