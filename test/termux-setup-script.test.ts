import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import nodeTest from "node:test";

// Fake executables and process-group signals require a Unix host.
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

const header = "#define TRANSCRIBE_VERSION_MAJOR 0\n#define TRANSCRIBE_VERSION_MINOR 2\n#define TRANSCRIBE_VERSION_PATCH 4\n";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-voice-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const source = join(root, "source");
  const bin = join(root, "bin");
  const binding = join(root, "node_modules/transcribe-cpp");
  const koffi = join(binding, "node_modules/koffi");
  for (const directory of [scripts, join(root, "src"), bin, join(source, "include"), join(binding, "dist"), koffi]) {
    await mkdir(directory, { recursive: true });
  }
  for (const file of ["scripts/setup-termux.mjs", "scripts/check-native.mjs", "src/termux-native-paths.mjs"]) {
    await copyFile(join(process.cwd(), file), join(root, file));
  }
  await writeFile(join(source, "include/transcribe.h"), header);
  await writeFile(join(binding, "package.json"), JSON.stringify({ name: "transcribe-cpp", version: "0.2.4", type: "module", exports: "./dist/index.mjs" }));
  await writeFile(join(binding, "dist/index.mjs"), `
import { appendFileSync, readFileSync } from 'node:fs';
export function getAvailableBackends() {
  appendFileSync(process.env.EVENTS, JSON.stringify(['smoke', process.env.TRANSCRIBE_LIBRARY]) + '\\n');
  if (readFileSync(process.env.TRANSCRIBE_LIBRARY, 'utf8') !== 'valid') throw Error('bad library');
  return [{ name: 'cpu', deviceType: 'cpu' }];
}
export const libraryPath = () => process.env.TRANSCRIBE_LIBRARY;
export const version = () => ({ version: '0.2.4' });
export const TranscribeModel = { load: async () => { throw Error('missing model'); } };
`);
  await writeFile(join(koffi, "index.js"), `
module.exports = {
  version: process.env.KOFFI_VERSION || '3.3.1',
  load: () => ({ func: () => ({ async: (data, count, size, compare, done) => {
    data.sort(compare); done(null);
  } }) }),
  proto: x => x, pointer: x => x, register: x => x, unregister: () => {}, decode: x => x,
};
`);
  const preload = join(root, "platform.mjs");
  await writeFile(preload, `Object.defineProperty(process, 'platform', { value: process.env.TEST_PLATFORM || 'android' });
Object.defineProperty(process, 'arch', { value: process.env.TEST_ARCH || 'arm64' });`);
  const toolScript = `#!${process.execPath}
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { spawn } = require('node:child_process');
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const event = value => appendFileSync(process.env.EVENTS, JSON.stringify(value) + '\\n');
event([tool, ...args]);
if (args[0] === '--version') process.exit(0);
if (tool === 'git') {
  const source = args.at(-1);
  mkdirSync(join(source, 'include'), { recursive: true });
  writeFileSync(join(source, 'include/transcribe.h'), ${JSON.stringify(header)});
} else if (tool === 'cmake' && args[0] === '-S') {
  const build = args[args.indexOf('-B') + 1];
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'prefix'), args.find(x => x.startsWith('-DCMAKE_INSTALL_PREFIX=')).split('=')[1]);
} else if (tool === 'cmake' && args[0] === '--build') {
  if (process.env.FAKE_FAIL === 'build') { console.error('simulated build failure'); process.exit(9); }
  if (process.env.FAKE_OUTPUT) require('node:fs').writeSync(1, Buffer.alloc(1024 * 1024, 65));
  if (process.env.FAKE_HANG) {
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    const descendant = spawn(process.execPath, ['-e', \
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
    descendant.stdout.once('data', () => event(['hanging', process.pid, descendant.pid]));
    setInterval(() => {}, 1000);
  }
} else if (tool === 'cmake' && args[0] === '--install') {
  const prefix = readFileSync(join(args[1], 'prefix'), 'utf8');
  mkdirSync(join(prefix, 'lib'), { recursive: true });
  writeFileSync(join(prefix, 'lib/libtranscribe.so'), process.env.FAKE_FAIL === 'smoke' ? 'invalid' : 'valid');
}
`;
  const env = {
    ...process.env,
    PATH: bin,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    XDG_CACHE_HOME: join(root, "cache"),
    EVENTS: join(root, "events.jsonl"),
    TRANSCRIBE_LIBRARY: join(root, "unrelated.so"),
  };
  const directory = join(env.XDG_CACHE_HOME, "pi-voice/native/transcribe-cpp-0.2.4/android-arm64");
  const library = join(directory, "lib/libtranscribe.so");
  const parent = dirname(directory);
  async function tools(names = ["git", "cmake", "ninja", "clang"]) {
    for (const name of names) {
      await writeFile(join(bin, name), toolScript);
      await chmod(join(bin, name), 0o755);
    }
  }
  function start(args: string[] = [], extra: NodeJS.ProcessEnv = {}, script = "setup-termux.mjs") {
    const child = spawn(process.execPath, [join(scripts, script), ...args], {
      env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    return { child, result };
  }
  const events = async (): Promise<Array<Array<string | number>>> => {
    try { return (await readFile(env.EVENTS, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  async function cache(contents = "valid") {
    await mkdir(join(directory, "lib"), { recursive: true });
    await writeFile(library, contents);
  }
  async function clean() {
    const files = await readdir(parent);
    assert.ok(!files.some(file => file.startsWith(".setup-") || file.endsWith(".lock")), files.join(", "));
    assert.ok(files.some(file => file.endsWith(".log")), "log retained");
  }
  return { root, source, koffi, env, directory, parent, library, tools, start, events, cache, clean };
}

test("Termux setup help and platform/jobs validation do not build", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start(["--help"], { TEST_PLATFORM: "linux" }).result).code, 0);
  assert.match((await f.start([], { TEST_ARCH: "x64" }).result).output, /Android arm64 only/);
  assert.match((await f.start(["--jobs", "0"]).result).output, /positive integer/);
  assert.deepEqual(await f.events(), []);
});

test("postinstall skips other platforms without dependencies, tools or cache writes", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "node_modules"), { recursive: true });
  for (const [platform, arch] of [["linux", "arm64"], ["darwin", "arm64"], ["win32", "x64"], ["android", "x64"]]) {
    const result = await f.start(["--postinstall"], { TEST_PLATFORM: platform, TEST_ARCH: arch }).result;
    assert.equal(result.code, 0, result.output);
  }
  assert.deepEqual(await f.events(), []);
  await assert.rejects(access(f.parent), { code: "ENOENT" });
});

test("Termux postinstall clones matching tag and atomically publishes a smoke-tested CPU build", async (t) => {
  const f = await fixture(t);
  await f.tools();
  const result = await f.start(["--postinstall"]).result;
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(f.library, "utf8"), "valid");
  const events = await f.events();
  const clone = events.find(event => event[0] === "git" && event[1] === "clone")!;
  assert.deepEqual(clone.slice(0, -1), ["git", "clone", "--depth", "1", "--branch", "v0.2.4", "https://github.com/handy-computer/transcribe.cpp"]);
  assert.ok(String(clone.at(-1)).startsWith(join(f.parent, ".setup-")));
  const configure = events.find(event => event[1] === "-S")!;
  for (const flag of ["-DGGML_NATIVE=OFF", "-DTRANSCRIBE_CUDA=OFF", "-DTRANSCRIBE_METAL=OFF", "-DTRANSCRIBE_VULKAN=OFF", "-DTRANSCRIBE_HIP=OFF", "-DCMAKE_INSTALL_RPATH=$ORIGIN"]) {
    assert.ok(configure.includes(flag), flag);
  }
  assert.deepEqual(events.find(event => event[1] === "--build")!.slice(-2), ["--parallel", "2"]);
  assert.match(String(events.find(event => event[0] === "smoke")![1]), /\.setup-.*\/install\/lib\/libtranscribe\.so$/);
  await f.clean();
});

test("Termux setup waits for slow consumers before reading more build output", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.tools();
  const running = f.start(["--source", f.source], { FAKE_OUTPUT: "1" });
  running.child.stdout.pause();
  t.after(() => {
    running.child.stdout.resume();
    try { process.kill(-running.child.pid!, "SIGKILL"); } catch {}
  });
  const deadline = Date.now() + 10000;
  while (!(await f.events()).some(event => event[1] === "--build") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok((await f.events()).some(event => event[1] === "--build"), "build started");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(!(await f.events()).some(event => event[1] === "--install"), "build output must not be buffered without limit");
  running.child.stdout.resume();
  const result = await running.result;
  assert.equal(result.code, 0, result.output.slice(-2000));
  await f.clean();
});

test("Termux --source does not require git and honors --jobs", async (t) => {
  const f = await fixture(t);
  await f.tools(["cmake", "ninja", "clang"]);
  const result = await f.start(["--source", f.source, "--jobs", "3"]).result;
  assert.equal(result.code, 0, result.output);
  const events = await f.events();
  assert.ok(!events.some(event => event[0] === "git"));
  assert.deepEqual(events.find(event => event[1] === "--build")!.slice(-2), ["--parallel", "3"]);
  await f.clean();
});

test("Termux setup reuses cache without tools; --check ignores external library overrides", async (t) => {
  const f = await fixture(t);
  await f.cache();
  for (const args of [[], ["--check"], ["--postinstall"]]) {
    const result = await f.start(args).result;
    assert.equal(result.code, 0, result.output);
  }
  assert.deepEqual(await f.events(), Array.from({ length: 3 }, () => ["smoke", f.library]));
  await f.clean();
});

test("Termux --check missing cache fails without any build or download", async (t) => {
  const f = await fixture(t);
  await f.tools();
  const result = await f.start(["--check"]).result;
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(await f.events(), [["smoke", f.library]]);
  await f.clean();
});

test("check-native defaults to shared cache and respects an explicit override", async (t) => {
  const f = await fixture(t);
  await f.cache();
  assert.equal((await f.start([], { TRANSCRIBE_LIBRARY: "" }, "check-native.mjs").result).code, 0);
  const override = join(f.root, "explicit.so");
  await writeFile(override, "valid");
  assert.equal((await f.start([], { TRANSCRIBE_LIBRARY: override }, "check-native.mjs").result).code, 0);
  assert.deepEqual(await f.events(), [["smoke", f.library], ["smoke", override]]);
});

test("Termux setup rejects binding-resolved old/missing Koffi before building", async (t) => {
  const f = await fixture(t);
  await f.cache();
  const old = await f.start([], { KOFFI_VERSION: "3.3.0" }).result;
  assert.equal(old.code, 1);
  assert.match(old.output, /Koffi 3\.3\.0.*node_modules\/transcribe-cpp\/node_modules\/koffi/);
  await writeFile(join(f.koffi, "index.js"), "throw Error('official addon missing');");
  const missing = await f.start().result;
  assert.equal(missing.code, 1);
  assert.match(missing.output, /optional dependencies enabled and Koffi >= 3\.3\.1/);
  assert.deepEqual(await f.events(), []);
  await f.clean();
});

test("Termux setup preserves another setup's lock", async (t) => {
  const f = await fixture(t);
  const lock = `${f.directory}.lock`;
  await mkdir(lock, { recursive: true });
  const result = await f.start().result;
  assert.equal(result.code, 1);
  assert.ok(result.output.includes(lock));
  await access(lock);
  assert.deepEqual(await f.events(), []);
});

test("Termux setup reports missing tools and mismatched headers", async (t) => {
  const f = await fixture(t);
  const missing = await f.start(["--postinstall", "--source", f.source]).result;
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Required build tool 'cmake' is unavailable/);
  await f.tools();
  await writeFile(join(f.source, "include/transcribe.h"), header.replace("PATCH 4", "PATCH 5"));
  const mismatch = await f.start(["--source", f.source]).result;
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.output, /Source is 0\.2\.5, but transcribe-cpp is 0\.2\.4/);
  assert.ok(!(await f.events()).some(event => event[1] === "-S"));
  await f.clean();
});

for (const failure of ["build", "smoke"]) {
  test(`Termux setup ${failure} failure retains old directory and logs, cleans temporary files`, async (t) => {
    const f = await fixture(t);
    await f.tools();
    await f.cache("old-invalid");
    const result = await f.start(["--source", f.source], { FAKE_FAIL: failure }).result;
    assert.equal(result.code, 1, result.output);
    assert.equal(await readFile(f.library, "utf8"), "old-invalid");
    await f.clean();
    const log = (await readdir(f.parent)).find(file => file.endsWith(".log"))!;
    assert.match(await readFile(join(f.parent, log), "utf8"), failure === "build" ? /simulated build failure/ : /bad library/);
  });
}

test("Termux setup replaces an invalid cache only after successful smoke", async (t) => {
  const f = await fixture(t);
  await f.tools();
  await f.cache("old-invalid");
  const result = await f.start(["--source", f.source]).result;
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(f.library, "utf8"), "valid");
  assert.equal((await f.events()).filter(event => event[0] === "smoke").length, 2);
  await f.clean();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`Termux setup ${signal} kills build descendants and cleans its lock`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await f.tools();
    const running = f.start(["--source", f.source], { FAKE_HANG: "1" });
    t.after(() => { try { process.kill(-running.child.pid!, "SIGKILL"); } catch {} });
    let hanging: Array<string | number> | undefined;
    const deadline = Date.now() + 10000;
    while (!hanging && Date.now() < deadline) {
      hanging = (await f.events()).find(event => event[0] === "hanging");
      if (!hanging) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(hanging, "fake build started");
    t.after(() => { for (const pid of hanging!.slice(1)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} } });
    const concurrent = await f.start(["--source", f.source]).result;
    assert.equal(concurrent.code, 1);
    assert.ok(concurrent.output.includes(`${f.directory}.lock`));
    process.kill(-running.child.pid!, signal);
    const result = await running.result;
    assert.equal(result.code, signal === "SIGTERM" ? 143 : 130, result.output);
    for (const pid of hanging.slice(1)) {
      try {
        // A killed orphan can briefly remain as a zombie until Android's init reaps it.
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        assert.match(stat, /\) Z /, `descendant ${pid} still running`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await f.clean();
  });
}
