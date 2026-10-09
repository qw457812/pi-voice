# Maintaining the Termux fork

Keep `main` as an upstream mirror and `termux` as the supported fork. `origin` is the fork; `upstream` is `https://github.com/earendil-works/pi-voice.git`. Published history uses merges, not rebases or force-pushes. For installation, see [Termux setup](termux.md).

## Keep the patch small

- Keep PulseAudio handling in `src/pulse-audio.ts`, source selection in `src/pulse-sources.ts`, and native setup/discovery in `scripts/setup-termux.mjs`, `scripts/check-native.mjs`, and `src/termux-native*`.
- Select platforms only at audio/native-loading boundaries. Reuse upstream's controller, transcription service, catalog, and desktop recorder; remove superseded fork patches rather than preserving their old implementations.
- Preserve startup cancellation in `src/runtime.ts`: register the listener before awaiting microphone startup, bypass the operation lock for cancellation, and clean up the listener on exit.
- Keep downstream tests separate and README changes limited to the installation link. Do not remove regression coverage just to reduce the diff.

## Sync upstream

Start with a clean worktree; commit or intentionally stash changes first. Run each stage separately and stop on errors. If `termux` is checked out elsewhere, work there.

```bash
git status --short
git remote -v
git fetch origin
git fetch upstream
git switch termux
git merge --ff-only origin/termux
git branch "backup/termux-before-sync-$(date +%Y%m%d-%H%M%S)"
git merge --no-commit --no-ff upstream/main
```

Resolve conflicts by behavior, not blanket `ours`/`theirs`: Android must not load handy recorder's native addon, PulseAudio must deliver drained PCM through `CaptureSinks`, and native discovery must precede loading `transcribe-cpp`. Use upstream's `OpenCapture` lifecycle; failed opening owns its cleanup. Review the fork with `git diff upstream/main`.

If the lockfile conflicts, resolve the manifest first, then rebuild from upstream's lockfile:

```bash
git restore --source=upstream/main --worktree -- package-lock.json
npm install --package-lock-only --ignore-scripts --include=optional
# Only if the resolved Koffi still lacks Android support:
npm update koffi --package-lock-only --ignore-scripts --include=optional
```

Keep the direct Koffi `^3.3.1` requirement until the binding itself guarantees an Android-capable version. Package consumers do not inherit this lockfile, and npm may nest dependencies; setup verifies the Koffi resolved by the binding. Avoid blanket dependency updates.

## Validate and publish

```bash
npm ci --ignore-scripts --include=optional
npm ls transcribe-cpp koffi
npm test
npm run termux:setup -- --check
npm run termux:check
npm pack --dry-run --ignore-scripts
git diff --check
git diff --cached --check
```

- If the managed library is missing or the binding changed, run `npm run termux:setup` first. Optional local sources: `npm run termux:setup -- --source /path/to/matching/transcribe.cpp --jobs 2`.
- Check a packed install with lifecycle scripts enabled and without the repository lockfile. Include docs, setup/check scripts, and the `.mjs` path helper; exclude native builds and `node_modules`.
- Run desktop tests too when shared audio behavior changes. Unit tests and native smoke checks do not establish real inference, recording, accuracy, or performance. Obtain approval before microphone access or model downloads.
- Stage only intended changes and inspect `git diff --cached --stat` before committing the pending merge. Push `origin termux` only after review. To abandon an in-progress merge, use `git merge --abort`; the backup does not save uncommitted files.
- Updating `main` is independent: fast-forward it to `upstream/main` in its owning worktree. Never merge `termux` into the mirror or reset divergent published history.

## Native cache recovery

Caches live under `$XDG_CACHE_HOME/pi-voice/native` (default `~/.cache/pi-voice/native`), keyed by binding version and platform. Setup reuses a smoke-tested cache, builds matching sources in isolation otherwise, and publishes by rename. It does not install system packages, download models, or access the microphone. Keep `libtranscribe.so` with its matching `libggml*.so` siblings.

A working cache wins even over `--source`. To rebuild the same version, stop Pi and move the cache aside; locate it with:

```bash
node --input-type=module -e "import { nativeInstallation } from './src/termux-native-paths.mjs'; console.log(nativeInstallation().directory)"
```

Restart Pi after changing native dependencies; unset old `TRANSCRIBE_LIBRARY` overrides to use managed discovery. Setup prints its retained log path. Use `npm_config_foreground_scripts=true` for live install output. SIGINT/SIGTERM stops build process groups and cleans up; after a hard kill, remove a stale `.lock` only after verifying no setup process remains. Adapt setup and tests if upstream changes its C API, CMake options, installation layout, or loader; never bypass ABI checks.
