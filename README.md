# Pi Voice

Local speech-to-text for Pi.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

## Install

For Android/Termux, use the [Termux setup](#termux-android-arm64) below instead of a normal npm install.

Install the npm package:

```bash
pi install npm:@earendil-works/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`. The `/voice` command is reserved for a future voice mode.

## Upgrading from pi-transcribe

It's recommended to install Pi Voice via NPM. If you have an older install of pi-transcribe uninstall it via: 

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with:

```bash
pi install npm:@earendil-works/pi-voice
```

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 128 MiB (about 35 minutes). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in the interactive TUI to choose and, after confirmation, download a local model.

## Termux (Android arm64)

Termux uses **PulseAudio for recording** and the existing **transcribe-cpp + Koffi backend for inference**. Models stay loaded between recordings; streaming remains available when supported by the selected model. There is no CLI transcription subprocess or cloud service.

Android cannot load the Linux/glibc transcribe-cpp native npm packages. Build the matching Android library from source instead. Koffi already supplies an official Android addon; the lockfile uses Koffi 3.3.1 with `transcribe-cpp` 0.2.4.

### 1. Prepare Termux and the microphone

Install the build and audio tools yourself:

```bash
pkg install nodejs git clang cmake ninja pulseaudio
# Optional: needed by transcribe_file, not by microphone capture
pkg install ffmpeg
```

Install the **Termux:API Android app from the same source as Termux** and grant its microphone permission in Android settings. The command-line `termux-api` package alone does not grant permission. PulseAudio captures the audio; Pi Voice does not invoke `termux-microphone-record`.

```bash
pulseaudio --start
pactl list short sources
# Only if no microphone source is loaded:
pactl load-module module-sles-source
```

A source such as `OpenSL_ES_source` is the microphone; `*.monitor` is speaker output and is excluded from the microphone picker. `SUSPENDED` is normal when the source is idle. Keep Termux in the foreground while recording; Android/OEM background restrictions and microphone privacy controls still apply. No TCP listener or anonymous PulseAudio access is needed.

### 2. Build the native backend

From this Pi Voice checkout:

```bash
npm ci --ignore-scripts --include=optional
# Or point --source below at an existing matching checkout.
git clone --branch v0.2.4 --depth 1 https://github.com/handy-computer/transcribe.cpp ../transcribe.cpp
npm run termux:setup -- --source ../transcribe.cpp
```

The helper uses two build jobs by default (`--jobs N` overrides this) and builds CPU-only libraries into `.termux/native/lib`. It uses Koffi's official Android addon without source patches. It does not pretend Android is Linux, install system packages, download models, or access the microphone.

Do not omit optional npm dependencies: they contain the Android Koffi addon. The older Koffi 3.1.4 lock entry lacked Android support; use this checkout's updated lockfile. Re-run setup when the transcribe-cpp version changes, using matching C++ sources. Keep `libtranscribe.so` and its sibling `libggml*.so` libraries together.

### 3. Load and verify

```bash
export TRANSCRIBE_LIBRARY="$PWD/.termux/native/lib/libtranscribe.so"
npm run termux:check
pi -e .
```

Set `TRANSCRIBE_LIBRARY` in every shell that launches Pi (or add the absolute-path export to your shell configuration). It is the upstream binding's library override, not a separate Pi Voice backend setting. `termux:check` checks native loading, ABI layouts, CPU discovery, asynchronous FFI, callbacks, and model-load error handling. It does **not** verify real model inference or performance.

Run `/voice-settings` to choose and explicitly download a model. Start with a small model supporting your language. Choose `OpenSL_ES_source` if needed: the default follows a real PulseAudio input, or the sole microphone when PulseAudio defaults to a speaker monitor. The existing shortcut starts/stops recording; choose a shortcut your Android keyboard can send.

Build references: [transcribe-cpp shared-library loading](https://github.com/handy-computer/transcribe.cpp/tree/v0.2.4/bindings/typescript#building-from-source), [Koffi Android support since 3.2.1](https://koffi.dev/changelog).

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:earendil-works/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```

