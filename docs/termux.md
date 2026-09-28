# Termux (Android arm64)

Termux uses **PulseAudio for recording** and **transcribe-cpp + Koffi for inference**. Models stay loaded between recordings; streaming remains available when supported by the selected model. There is no CLI transcription subprocess or cloud service.

## 1. Install tools and this fork

Install the build and audio tools yourself; Pi Voice never runs the system package manager:

```bash
pkg install git clang cmake ninja pulseaudio
# Optional: needed by transcribe_file, not by microphone capture
pkg install ffmpeg

pi install git:github.com/qw457812/pi-voice@termux
```

On Android arm64, `postinstall` checks the native cache and reuses it if its smoke check passes. Otherwise it downloads the C++ source tag matching the installed `transcribe-cpp`, compiles CPU-only shared libraries with two jobs, checks them, and installs them into the cache. **Installation waits for compilation and fails if the build fails.** Keep Termux in the foreground; the first build can take several minutes and needs temporary disk space. On other platforms, this postinstall step does nothing.

Use this fork's `termux` branch, not the upstream npm package, which does not contain this install hook. There is no extra Pi setup command, no manual source checkout, and no required shell export. Start Pi after installation, or `/reload` if it is already running. Restart Pi after upgrading the native binding version.

The native libraries live outside the installed package:

```text
${XDG_CACHE_HOME:-~/.cache}/pi-voice/native/transcribe-cpp-<version>/android-arm64/
```

Package updates do not remove this cache. Builds are staged separately and published only after the no-model native smoke check passes. This fork does not commit `.so` files, publish a separate native package, or download precompiled transcribe-cpp releases. Koffi itself uses its official Android addon; the package directly declares `^3.3.1`, and setup checks the version actually resolved by the binding. Keep optional npm dependencies enabled, since they contain that addon.

Installing this fork permits its native source download/build. It does **not** install system packages, download models, or access the microphone. There is no runtime download or automatic recovery UI.

## 2. Enable microphone access and choose a model

For traditional Termux builds that share an Android UID with their plugins, install the **Termux:API Android app from the same source as Termux** and grant it microphone permission in Android settings. [Termux maintainers explain](https://github.com/termux/termux-app/issues/2871#issuecomment-1719024276) that this propagates microphone permission to Termux, allowing PulseAudio's `module-sles-source` to capture through OpenSL ES. The command-line `termux-api` package alone does not grant permission. PulseAudio captures the audio; Pi Voice does not invoke `termux-microphone-record`. Other Termux distributions may handle permissions differently; if the source fails to initialize or returns no audio, check that distribution's microphone permissions.

```bash
pulseaudio --start
pactl list short sources
# Only if no microphone source is loaded:
pactl load-module module-sles-source
```

A source such as `OpenSL_ES_source` is the microphone; `*.monitor` is speaker output and is excluded from the microphone picker. `SUSPENDED` is normal when the source is idle. Keep Termux in the foreground while recording; Android/OEM background restrictions and microphone privacy controls still apply. No TCP listener or anonymous PulseAudio access is needed.

Run `/voice-settings` to choose and explicitly download a model. Start with a small model supporting your language. Choose `OpenSL_ES_source` if needed: the default follows a real PulseAudio input, or the sole microphone when PulseAudio defaults to a speaker monitor. Choose a recording shortcut your Android keyboard can send.

## Failed or skipped install scripts

If compilation fails, fix the reported problem (for example, a missing build tool or failed source download), then retry installation. Setup prints its log path and retains the complete log next to the versioned cache. npm may hide dependency script output during a successful install; use `npm_config_foreground_scripts=true pi install git:github.com/qw457812/pi-voice@termux` to display it live.

If npm lifecycle scripts were disabled, or you want to retry without reinstalling, run the same build helper from the **installed Pi Voice package directory**:

```bash
npm run termux:setup
# Equivalent, even when npm is configured to ignore lifecycle scripts:
node scripts/setup-termux.mjs
```

Nothing is compiled automatically when Pi starts or when you press the recording shortcut. Missing native libraries produce an error explaining how to rerun setup.

## Advanced: local sources and library overrides

For contributors running from a checkout:

```bash
npm ci --ignore-scripts --include=optional   # Deliberately skip automatic compilation
npm run termux:setup                        # Fetch matching sources if a build is needed
npm run termux:setup -- --source /path/to/transcribe.cpp --jobs 2
npm run termux:setup -- --check              # Check cache only; never download or build
npm run termux:check                        # Check the active override, or the cache
pi -e .
```

`--source` is optional and must match the installed binding version. An already working cache is reused even when `--source` is supplied. Stop Pi and move the cached installation aside if you need to force a rebuild of the same version; see the [maintenance guide](maintaining-termux.md#rebuilding-after-a-native-dependency-change).

`TRANSCRIBE_LIBRARY` remains an advanced override and takes precedence over automatic discovery. Existing `.termux/native/lib` builds can still be used this way. The install/build helper always builds/checks the managed cache without changing an explicit override; unset the override and restart Pi to switch back to managed loading. Keep `libtranscribe.so` and its sibling `libggml*.so` libraries together.

The native smoke check covers library loading, ABI layouts, CPU discovery, asynchronous FFI, callbacks, and model-load error handling. It does **not** verify real model inference or performance.

Build references: [transcribe-cpp shared-library loading](https://github.com/handy-computer/transcribe.cpp/tree/v0.2.4/bindings/typescript#building-from-source), [Koffi Android support](https://koffi.dev/changelog).
