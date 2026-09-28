import { existsSync } from "node:fs";
import { nativeInstallation } from "./termux-native-paths.mjs";

/** Resolve managed Termux builds before the binding first initializes native code. */
export function configureTermuxNative(platform = process.platform): void {
  if (platform !== "android" || process.env.TRANSCRIBE_LIBRARY) return;
  const { library, version } = nativeInstallation();
  if (!existsSync(library)) {
    throw new Error(
      `The Termux backend for transcribe-cpp ${version} is not installed. Reinstall Pi Voice with npm lifecycle scripts enabled, or run npm run termux:setup from its installed package directory. Expected library: ${library}`,
    );
  }
  process.env.TRANSCRIBE_LIBRARY = library;
}

export async function loadTranscribeCpp(): Promise<typeof import("transcribe-cpp")> {
  configureTermuxNative();
  return import("transcribe-cpp");
}
