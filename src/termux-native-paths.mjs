import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared by the package runtime and the standalone setup/check scripts. No native loading. */
export function nativeInstallation({
  bindingEntry = import.meta.resolve("transcribe-cpp"),
  cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const bindingRoot = resolve(dirname(fileURLToPath(bindingEntry)), "..");
  const binding = JSON.parse(readFileSync(join(bindingRoot, "package.json"), "utf8"));
  if (binding.name !== "transcribe-cpp" || !/^\d+\.\d+\.\d+(?:[-+][\da-z.-]+)?$/i.test(binding.version)) {
    throw new Error("Cannot determine the installed transcribe-cpp version.");
  }
  const directory = join(resolve(cacheRoot), "pi-voice", "native", `transcribe-cpp-${binding.version}`, `${platform}-${arch}`);
  return {
    version: binding.version,
    bindingEntry,
    directory,
    library: join(directory, "lib", "libtranscribe.so"),
  };
}
