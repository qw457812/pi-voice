# Maintaining the Termux fork

Keep `main` as an upstream mirror and `termux` as the supported fork branch. `origin` is the fork; `upstream` is `https://github.com/earendil-works/pi-voice.git`. Check `git remote -v` before syncing. The published `termux` branch uses merges, not rebases or force-pushes.

For installation, see [Termux setup](termux.md). This guide does not automatically merge, publish, download models, or start recording.

## Keep the downstream patch small

- Put PulseAudio process handling in `src/pulse-audio.ts`, pure source parsing/selection in `src/pulse-sources.ts`, and native build/check logic in `scripts/*-termux.mjs` / `scripts/check-native.mjs`. Do not copy upstream's transcription service, model catalog, or desktop recorder into a second implementation.
- Keep platform selection at the audio/native-loading boundaries. `src/termux-native.ts` handles automatic library discovery; `postinstall` invokes the standalone build helper only on Android arm64. Do not add setup commands or runtime build/recovery flows. `src/termux-native-paths.mjs` is shared by runtime and standalone scripts, with types in the adjacent `.d.mts`. The controller's async capture contract is platform-neutral; avoid Android checks in the controller or runtime.
- Keep downstream regression tests in separate files, reusing upstream test helpers. Do not reorganize upstream tests merely to accommodate the fork.
- Keep setup and maintenance details here under `docs/`; README needs only a link.
- Keep feature changes, dependency upgrades, and unrelated cleanup in separate future commits. Do not rewrite existing published commits to split them.
- When upstream implements an equivalent fix, use that implementation and remove the redundant fork patch after running the regression tests. Async startup/cancellation and final-frame draining are candidates for independent upstream fixes.

### Shared-code integration points

These differences are intentional. During conflicts, preserve the behavior, not necessarily the exact patch:

| File | Required behavior | Regression coverage |
| --- | --- | --- |
| `src/audio.ts` | Do not load PvRecorder on Android; select PulseAudio there; allow async device discovery. Preserve desktop recording. | `test/pulse-sources.test.ts`, `test/pulse-audio.test.ts`, plus platform smoke tests |
| `src/microphone-picker.ts` | Await device discovery and retain its error reporting. | Microphone selection smoke test |
| `src/dictation-controller.ts` | Own the capture before awaiting startup; cancel or clean up failed startup; ignore stale readiness; feed drained PCM before finishing the stream. | `test/dictation-async-capture.test.ts`, upstream controller tests |
| `src/runtime.ts` | Register cancellation during startup, bypass the operation lock for that cancellation, and remove listeners on exit. | `test/runtime.test.ts` |
| `src/file-audio.ts` | Give the Termux FFmpeg install hint. | `test/file-audio.test.ts`, missing-FFmpeg smoke test |
| `src/transcription.ts` | Use the native-loading boundary before importing the binding; preserve explicit library overrides and desktop behavior. | `test/termux-native.test.ts`, native smoke check |
| `scripts/run-tests.mjs` | Copy the shared `.mjs` path helper alongside compiled tests. | Full test run |
| `package.json` / `package-lock.json` | Declare the Android-compatible Koffi minimum, preserve the Android-arm64-only postinstall hook, and package its scripts and path helper. | `test/termux-setup-script.test.ts`, clean package install, native check |

Native caches now live outside the package under `$XDG_CACHE_HOME/pi-voice/native` (default `~/.cache/pi-voice/native`). Keep `.termux/` ignored for older developer builds; neither location belongs in version control.

## Sync upstream

Run each stage separately and stop on errors. Start with a clean worktree: commit or intentionally stash local changes first. If `termux` is already checked out in another worktree, run the sync there rather than forcing a checkout.

```bash
git status --short
git fetch origin
git fetch upstream
git switch termux
git merge --ff-only origin/termux
```

If the fast-forward fails because local and published histories diverged, reconcile that first; do not reset or force-push over published work.

Create a local recovery reference, then merge without committing so validation comes first:

```bash
git branch "backup/termux-before-sync-$(date +%Y%m%d-%H%M%S)"
git merge --no-commit --no-ff upstream/main
```

If already up to date, there is no merge to commit. Otherwise:

1. Inspect `git status` and `git diff --name-only --diff-filter=U`.
2. Resolve conflicts using the integration table above. Do not apply a blanket `ours`/`theirs` strategy or retain old upstream code solely to preserve a patch.
3. Stage only the resolved files. Follow the dependency procedure below if needed.
4. Run the validation checklist before committing.

To abandon an **in-progress** merge, use `git merge --abort`. The backup branch preserves the pre-sync commits, but not uncommitted files or ignored native builds. After publishing, fix mistakes with reviewed follow-up commits rather than resetting shared history.

When validation passes and a merge is pending:

```bash
git diff --cached --check
git diff --cached --stat
git commit
# Publish only after reviewing the merge and test results:
git push origin termux
```

Updating `main` is optional and independent of testing the fork. In the worktree that owns `main`, fast-forward it to `upstream/main` and push to `origin/main` if desired. Never merge `termux` into the upstream mirror; if `main` has diverged, inspect it instead of force-resetting it.

## Dependencies and lockfile conflicts

Merge `package.json` first. Accept upstream's intended dependency changes rather than freezing `transcribe-cpp` at the original fork version. This fork directly declares Koffi `^3.3.1`, the validated minimum, because npm package consumers do not inherit the repository lockfile. The old 3.1.4 lock entry did not support Android. Do not assume a future version works without checking it on Termux.

If `package-lock.json` conflicts, reconstruct it deliberately from upstream's lockfile plus the merged manifest, including the direct Koffi requirement:

```bash
# Only for a conflicted lockfile, after resolving package.json:
git restore --source=upstream/main --worktree -- package-lock.json
npm install --package-lock-only --ignore-scripts --include=optional
# Only if upstream's resolved Koffi still needs the Android update:
npm update koffi --package-lock-only --ignore-scripts --include=optional
git diff -- package.json package-lock.json
git add package.json package-lock.json
```

Review unexpected dependency churn; avoid a blanket `npm update` or deleting the entire lockfile. Remove the direct Koffi requirement only if the upstream binding's dependency range itself guarantees a working Android version, not merely because its current lockfile resolves one. npm can nest incompatible dependency versions, so setup checks the Koffi actually resolved from the binding. If that copy is too old, fix the dependency graph rather than bypassing the check or adding an unverified override.

## Rebuilding after a native dependency change

On Android arm64, normal installation runs the native build/check helper through `postinstall`. After updating the native binding, restart Pi. If lifecycle scripts were disabled, run the helper yourself from the installed package directory or checkout:

```bash
npm run termux:setup
# Optional: use local sources instead of downloading the matching release tag.
npm run termux:setup -- --source /path/to/matching/transcribe.cpp --jobs 2
```

The helper reads the installed binding version, checks existing cached libraries, and reuses a working cache without requiring build tools. Otherwise it builds in an isolated temporary directory, checks source/header compatibility, runs the native smoke check, and atomically publishes the complete installation. Failed builds do not replace an existing installation. Library paths are versioned, so a new binding version cannot silently reuse an old ABI. No environment export is needed; unset any old `TRANSCRIBE_LIBRARY` override and restart Pi to use managed discovery.

To force rebuilding the **same** version (for example, when testing modified C++ sources), stop Pi, locate its cache directory with the following command, and move that directory aside before setup. A working cache otherwise wins even over `--source`:

```bash
node --input-type=module -e "import { nativeInstallation } from './src/termux-native-paths.mjs'; console.log(nativeInstallation().directory)"
```

The setup log path is printed at startup. Use `npm_config_foreground_scripts=true` when installing to see dependency build output live; otherwise npm may show it only on failure. Logs are retained next to versioned installations; temporary source/build files are removed. SIGINT/SIGTERM cancellation stops build process groups and cleans up the lock. A hard kill or device shutdown can leave an adjacent `.lock` directory; remove it manually only after verifying no setup process is still running.

If upstream changes its C API, CMake options, install layout, or binding loader, adapt the helper and tests; do not bypass ABI checks or pretend Android is Linux. Keep `libtranscribe.so` and its matching `libggml*.so` siblings together.

## Validation checklist

From the merged checkout on Termux:

```bash
npm ci --ignore-scripts --include=optional
npm ls transcribe-cpp koffi
npm test
```

Rebuild as above if the native dependency changed or the library is missing. Then:

```bash
npm run termux:setup -- --check  # Managed cache only, no network/build
npm run termux:check            # Explicit override, if set, otherwise managed cache
npm pack --dry-run --ignore-scripts
```

- Confirm package contents include `docs/`, setup/check scripts, the audio modules, and `src/termux-native-paths.mjs`, but exclude `.termux/` and `node_modules/`.
- Test a packed npm install with lifecycle scripts enabled and without the repository lockfile, as well as a checkout install. Check that postinstall builds or reuses the cache, resolves Android-capable Koffi, skips other platforms, and fails clearly on build errors. Native loading should need no manual export.
- Run the upstream test suite on a supported desktop platform too when shared audio/controller behavior changes. Termux tests do not prove desktop native capture works.
- With explicit microphone/model approval, manually check device selection, startup cancellation, recording/stop, and real transcription. Model downloads and recording are not part of the automated sync procedure.
- Report which checks actually ran. Unit tests and the no-model native check do **not** establish speech-recognition accuracy, performance, or successful inference with a real model.
