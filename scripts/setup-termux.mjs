import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { nativeInstallation } from "../src/termux-native-paths.mjs";

const checkScript = fileURLToPath(new URL("./check-native.mjs", import.meta.url));

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      jobs: { type: "string", default: "2" },
      check: { type: "boolean" },
      postinstall: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: node scripts/setup-termux.mjs [--source /path/to/transcribe.cpp] [--jobs 2] [--check]

Build the installed transcribe-cpp version for Termux Android arm64.
Without --source, clone its matching upstream tag into a temporary directory.
An existing working cache is checked and reused without build tools.
--check only runs the cached native smoke check; it never downloads or builds.
--postinstall skips platforms other than Android arm64 (used by npm).
Requires Koffi >= 3.3.1 with its official Android addon. Building requires
cmake, ninja, clang, and (unless --source is supplied) git.
No system packages or models are installed; the microphone is not accessed.`);
    return;
  }
  if (process.platform !== "android" || process.arch !== "arm64") {
    if (values.postinstall) return;
    throw new Error("This helper supports Termux on Android arm64 only.");
  }
  if (!/^[1-9]\d*$/.test(values.jobs)) throw new Error("--jobs must be a positive integer.");

  const installation = nativeInstallation();
  const parent = dirname(installation.directory);
  await mkdir(parent, { recursive: true });
  const logPath = join(parent, `setup-${Date.now()}-${randomUUID()}.log`);
  const log = openSync(logPath, "ax");
  console.log(`Native setup log: ${logPath}`);
  const lock = `${installation.directory}.lock`;
  let ownsLock = false;
  let temporary;
  let child;
  let interrupted;
  let stopping;

  function report(message) {
    console.log(message);
    writeSync(log, `${message}\n`);
  }

  function killGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") report(`Could not signal process group ${pid}: ${error.message}`);
    }
  }

  function interrupt(signal) {
    if (interrupted) return;
    interrupted = signal;
    // Each command owns a process group, so git/cmake/ninja grandchildren also stop.
    // Keep the escalation even if the direct child exits before its descendants.
    if (child?.pid) {
      const pid = child.pid;
      killGroup(pid, signal);
      stopping = new Promise((done) => setTimeout(() => {
        killGroup(pid, "SIGKILL");
        done();
      }, 1500));
    }
  }
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  function assertRunning() {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
  }

  async function run(command, args, env = {}) {
    assertRunning();
    report(`\n> ${command} ${args.join(" ")}`);
    await new Promise((done, reject) => {
      child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CMAKE_BUILD_PARALLEL_LEVEL: values.jobs, MAKEFLAGS: `-j${values.jobs}`, ...env },
      });
      for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on("data", (data) => {
          writeSync(log, data);
          if (!output.write(data)) {
            stream.pause();
            output.once("drain", () => stream.resume());
          }
        });
      }
      child.once("error", reject);
      child.once("close", (code, signal) => {
        child = undefined;
        if (code === 0) done();
        else reject(new Error(`${command} failed (${signal ?? code}).`));
      });
    });
    assertRunning();
  }

  const smoke = (library) => run(process.execPath, [checkScript], { TRANSCRIBE_LIBRARY: library });

  try {
    // Resolve from the binding, not from this package: npm may nest Koffi.
    const require = createRequire(installation.bindingEntry);
    let koffi;
    try {
      koffi = require("koffi");
    } catch (cause) {
      throw new Error(`The Koffi resolved by transcribe-cpp cannot load its official Android arm64 addon. Reinstall the package with optional dependencies enabled and Koffi >= 3.3.1; no npm update was run. ${cause.message}`);
    }
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(koffi.version ?? "");
    if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 &&
      (Number(version[2]) < 3 || (Number(version[2]) === 3 && Number(version[3]) < 1)))) {
      throw new Error(`transcribe-cpp resolves Koffi ${koffi.version ?? "unknown"} at ${require.resolve("koffi")}. Termux requires >= 3.3.1 (the validated minimum) with its official Android addon. Update that dependency with optional dependencies enabled; no npm update was run.`);
    }
    report(`Using Koffi ${koffi.version} at ${require.resolve("koffi")}.`);
    if (values.check) {
      await smoke(installation.library);
      return;
    }

    assertRunning();
    try {
      await mkdir(lock);
      ownsLock = true;
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Another native setup may be running. Lock: ${lock}. Wait for it to finish; remove this lock manually only after confirming its owner is no longer running.`);
      }
      throw error;
    }

    let exists = false;
    try {
      await access(installation.library);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) {
      try {
        await smoke(installation.library);
        report(`Reusing native cache: ${installation.directory}`);
        return;
      } catch (error) {
        assertRunning();
        report(`Cached native smoke failed; rebuilding in isolation. ${error.message}`);
      }
    }

    for (const tool of ["cmake", "ninja", "clang", ...(values.source ? [] : ["git"])]) {
      try {
        await run(tool, ["--version"]);
      } catch (error) {
        assertRunning();
        throw new Error(`Required build tool '${tool}' is unavailable. Install it in Termux and retry; this script does not install system packages. ${error.message}`);
      }
    }
    assertRunning();
    // Under the cache parent so publication by rename is always on one filesystem.
    temporary = await mkdtemp(join(parent, ".setup-"));
    const source = values.source ? resolve(values.source) : join(temporary, "source");
    if (!values.source) {
      await run("git", ["clone", "--depth", "1", "--branch", `v${installation.version}`,
        "https://github.com/handy-computer/transcribe.cpp", source]);
    }
    const header = await readFile(join(source, "include", "transcribe.h"), "utf8");
    const sourceVersion = ["MAJOR", "MINOR", "PATCH"].map((part) => {
      const match = header.match(new RegExp(`#define\\s+TRANSCRIBE_VERSION_${part}\\s+(\\d+)`));
      if (!match) throw new Error(`Cannot read TRANSCRIBE_VERSION_${part} from ${source}.`);
      return match[1];
    }).join(".");
    if (sourceVersion !== installation.version) {
      throw new Error(`Source is ${sourceVersion}, but transcribe-cpp is ${installation.version}. Use matching sources.`);
    }

    const build = join(temporary, "build");
    const prefix = join(temporary, "install");
    await run("cmake", [
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
      "-DGGML_NATIVE=OFF",
    ]);
    await run("cmake", ["--build", build, "--target", "transcribe", "--parallel", values.jobs]);
    await run("cmake", ["--install", build]);
    await smoke(join(prefix, "lib", "libtranscribe.so"));
    assertRunning();

    // Never overwrite a loaded .so. Move an invalid old directory aside, then
    // publish the entire smoke-tested install with one atomic rename.
    const previous = join(temporary, "previous");
    let movedPrevious = false;
    try {
      await rename(installation.directory, previous);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(prefix, installation.directory);
    } catch (error) {
      if (movedPrevious) await rename(previous, installation.directory);
      throw error;
    }
    report(`Native setup complete: ${installation.library}`);
    report("No environment override is needed. No model was downloaded and the microphone was not accessed.");
  } catch (error) {
    report(`Native setup failed: ${error.message}\nLog: ${logPath}`);
    throw error;
  } finally {
    // Do not remove build files or release the lock until descendants have stopped.
    await stopping;
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      try {
        if (ownsLock) await rm(lock, { recursive: true, force: true });
      } finally {
        closeSync(log);
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode ||= 1;
});
