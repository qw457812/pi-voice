import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    jobs: { type: "string", default: "2" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log("Usage: node scripts/setup-termux.mjs --source /path/to/transcribe.cpp [--jobs 2]");
  process.exit(0);
}
if (process.platform !== "android" || process.arch !== "arm64") {
  throw new Error("This source-build helper supports Termux on Android arm64 only.");
}
if (!values.source) throw new Error("Pass --source with a transcribe.cpp checkout matching the installed binding version.");
if (!/^[1-9]\d*$/.test(values.jobs)) throw new Error("--jobs must be a positive integer.");

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(values.source);
const build = join(root, ".termux", "build");
const prefix = join(root, ".termux", "native");
const bindingEntry = import.meta.resolve("transcribe-cpp");
const bindingRoot = resolve(dirname(fileURLToPath(bindingEntry)), "..");
const binding = JSON.parse(await readFile(join(bindingRoot, "package.json"), "utf8"));
const header = await readFile(join(source, "include", "transcribe.h"), "utf8");
const version = ["MAJOR", "MINOR", "PATCH"].map((part) => {
  const match = header.match(new RegExp(`#define\\s+TRANSCRIBE_VERSION_${part}\\s+(\\d+)`));
  if (!match) throw new Error(`Cannot read TRANSCRIBE_VERSION_${part} from ${source}.`);
  return match[1];
}).join(".");
if (version !== binding.version) {
  throw new Error(`Source is ${version}, but transcribe-cpp is ${binding.version}. Use matching sources.`);
}

function run(command, args, cwd = root) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: values.jobs, MAKEFLAGS: `-j${values.jobs}` },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}).`);
}

// Koffi >= 3.2.1 ships official Android addons; keep optional dependencies enabled.
// https://koffi.dev/changelog
const require = createRequire(bindingEntry);
try {
  const koffi = require("koffi");
  console.log(`Using Koffi ${koffi.version} (${process.platform}-${process.arch}).`);
} catch (cause) {
  throw new Error("Koffi's Android addon is unavailable. Run npm ci --ignore-scripts --include=optional with the updated lockfile.", { cause });
}

// The upstream npm build:native helper rejects process.platform === "android".
// Build the same shared C API directly and use its documented library override:
// https://github.com/handy-computer/transcribe.cpp/tree/v0.2.4/bindings/typescript#building-from-source
run("cmake", [
  "-S", source, "-B", build, "-G", "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  `-DCMAKE_INSTALL_PREFIX=${prefix}`,
  "-DCMAKE_INSTALL_LIBDIR=lib",
  "-DCMAKE_INSTALL_RPATH=$ORIGIN",
  "-DTRANSCRIBE_BUILD_SHARED=ON",
  "-DTRANSCRIBE_BUILD_TESTS=OFF",
  "-DTRANSCRIBE_BUILD_EXAMPLES=OFF",
  "-DTRANSCRIBE_BUILD_TOOLS=OFF",
  "-DTRANSCRIBE_USE_SYSTEM_BLAS=OFF",
  "-DTRANSCRIBE_USE_OPENMP=OFF",
  "-DTRANSCRIBE_METAL=OFF",
  "-DTRANSCRIBE_VULKAN=OFF",
  "-DTRANSCRIBE_CUDA=OFF",
  "-DTRANSCRIBE_HIP=OFF",
  "-DGGML_CCACHE=OFF",
]);
run("cmake", ["--build", build, "--target", "transcribe", "--parallel", values.jobs]);
run("cmake", ["--install", build]);

process.env.TRANSCRIBE_LIBRARY = join(prefix, "lib", "libtranscribe.so");
run(process.execPath, [join(root, "scripts", "check-native.mjs")]);
const quotedLibrary = `'${process.env.TRANSCRIBE_LIBRARY.replaceAll("'", "'\\''")}'`;
console.log(`\nNative setup complete. Before starting Pi in this shell:\nexport TRANSCRIBE_LIBRARY=${quotedLibrary}\npi -e .`);
console.log("No model was downloaded and the microphone was not accessed.");
