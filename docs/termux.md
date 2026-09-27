# Termux (Android arm64)

Termux uses **PulseAudio for recording** and the existing **transcribe-cpp + Koffi backend for inference**. Models stay loaded between recordings; streaming remains available when supported by the selected model. There is no CLI transcription subprocess or cloud service.

Android cannot load the Linux/glibc transcribe-cpp native npm packages. Build the matching Android library from source instead. Koffi supplies an official Android addon. The initial native smoke checks passed with Koffi 3.3.1 and `transcribe-cpp` 0.2.4; later dependency upgrades must be checked again.

For updating this fork, see [Maintaining the Termux fork](maintaining-termux.md).

## 1. Prepare Termux and the microphone

Install the build and audio tools yourself:

```bash
pkg install nodejs git clang cmake ninja pulseaudio
# Optional: needed by transcribe_file, not by microphone capture
pkg install ffmpeg
```

For traditional Termux builds that share an Android UID with their plugins, install the **Termux:API Android app from the same source as Termux** and grant it microphone permission in Android settings. [Termux maintainers explain](https://github.com/termux/termux-app/issues/2871#issuecomment-1719024276) that this propagates microphone permission to Termux, allowing PulseAudio's `module-sles-source` to capture through OpenSL ES. The command-line `termux-api` package alone does not grant permission. PulseAudio captures the audio; Pi Voice does not invoke `termux-microphone-record`. Other Termux distributions may handle permissions differently; if the source fails to initialize or returns no audio, check that distribution's microphone permissions.

```bash
pulseaudio --start
pactl list short sources
# Only if no microphone source is loaded:
pactl load-module module-sles-source
```

A source such as `OpenSL_ES_source` is the microphone; `*.monitor` is speaker output and is excluded from the microphone picker. `SUSPENDED` is normal when the source is idle. Keep Termux in the foreground while recording; Android/OEM background restrictions and microphone privacy controls still apply. No TCP listener or anonymous PulseAudio access is needed.

## 2. Build the native backend

From this Pi Voice checkout:

```bash
npm ci --ignore-scripts --include=optional
version=$(node -p "require('./node_modules/transcribe-cpp/package.json').version")
# Or point --source below at an existing checkout matching this version.
git clone --branch "v$version" --depth 1 https://github.com/handy-computer/transcribe.cpp ../transcribe.cpp
npm run termux:setup -- --source ../transcribe.cpp
```

The helper uses two build jobs by default (`--jobs N` overrides this) and builds CPU-only libraries into `.termux/native/lib`. It uses Koffi's official Android addon without source patches. It does not pretend Android is Linux, install system packages, download models, or access the microphone.

Do not omit optional npm dependencies: they contain the Android Koffi addon. The older Koffi 3.1.4 lock entry lacked Android support; use this fork's updated lockfile. Re-run setup when the transcribe-cpp version changes, using matching C++ sources. Keep `libtranscribe.so` and its sibling `libggml*.so` libraries together. When changing the source checkout location or native version, follow the [rebuild procedure](maintaining-termux.md#rebuilding-after-a-native-dependency-change).

## 3. Load and verify

```bash
export TRANSCRIBE_LIBRARY="$PWD/.termux/native/lib/libtranscribe.so"
npm run termux:check
pi -e .
```

Set `TRANSCRIBE_LIBRARY` in every shell that launches Pi (or add the absolute-path export to your shell configuration). It is the upstream binding's library override, not a separate Pi Voice backend setting. `termux:check` checks native loading, ABI layouts, CPU discovery, asynchronous FFI, callbacks, and model-load error handling. It does **not** verify real model inference or performance.

Run `/voice-settings` to choose and explicitly download a model. Start with a small model supporting your language. Choose `OpenSL_ES_source` if needed: the default follows a real PulseAudio input, or the sole microphone when PulseAudio defaults to a speaker monitor. The existing shortcut starts/stops recording; choose a shortcut your Android keyboard can send.

Build references: [transcribe-cpp shared-library loading](https://github.com/handy-computer/transcribe.cpp/tree/v0.2.4/bindings/typescript#building-from-source), [Koffi Android support since 3.2.1](https://koffi.dev/changelog).
