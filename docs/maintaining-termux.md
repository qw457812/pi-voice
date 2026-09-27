# Maintaining the Termux fork

Keep `main` as an upstream mirror and `termux` as the supported fork branch. `origin` is the fork; `upstream` is `https://github.com/earendil-works/pi-voice.git`. Check `git remote -v` before syncing. The published `termux` branch uses merges, not rebases or force-pushes.

For installation, see [Termux setup](termux.md). This guide does not automatically merge, publish, download models, or start recording.

## Keep the downstream patch small

- Put PulseAudio process handling in `src/pulse-audio.ts`, pure source parsing/selection in `src/pulse-sources.ts`, and native build/check logic in `scripts/*-termux.mjs` / `scripts/check-native.mjs`. Do not copy upstream's transcription service, model catalog, or desktop recorder into a second implementation.
- Keep platform selection at the audio boundary. The controller's async capture contract is platform-neutral; avoid Android checks in the controller or runtime.
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
| `package.json` / `package-lock.json` | Preserve upstream dependencies while retaining a working Android Koffi addon, setup/check commands, and packaged docs/scripts. | Clean npm install, package dry run, native check |

Keep `.termux/` ignored. It contains machine-specific generated builds and libraries, not portable source files.

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

Merge `package.json` first. Accept upstream's intended dependency changes rather than freezing `transcribe-cpp` at the original fork version. Koffi is transitive: the old 3.1.4 lock entry did not support Android; 3.3.1 passed this fork's initial native checks. Do not assume a future version works without checking it on Termux.

If `package-lock.json` conflicts, reconstruct it deliberately from upstream's lockfile plus the merged manifest and any fork-only dependency requirements. For the current fork, the only lockfile-specific requirement is an Android-capable Koffi:

```bash
# Only for a conflicted lockfile, after resolving package.json:
git restore --source=upstream/main --worktree -- package-lock.json
npm install --package-lock-only --ignore-scripts --include=optional
# Only if upstream's resolved Koffi still needs the Android update:
npm update koffi --package-lock-only --ignore-scripts --include=optional
git diff -- package.json package-lock.json
git add package.json package-lock.json
```

Review unexpected dependency churn; avoid a blanket `npm update` or deleting the entire lockfile. If upstream already resolves a working Android addon, drop the obsolete downstream lockfile difference. If `transcribe-cpp` changes its Koffi dependency range, review compatibility rather than adding an unverified override.

## Rebuilding after a native dependency change

After installing the merged dependencies, read the binding version and use matching C++ sources. Do not infer it from the previous build or hard-code the initial 0.2.4 release:

```bash
version=$(node -p "require('./node_modules/transcribe-cpp/package.json').version")
# Use an existing matching checkout instead if this directory already exists.
git clone --branch "v$version" --depth 1 https://github.com/handy-computer/transcribe.cpp "../transcribe.cpp-$version"
```

Stop Pi processes using these libraries before rebuilding. CMake caches the source path, so a different checkout location needs a fresh build directory. For a native upgrade, also remove the old install to avoid mixing GGML libraries. The following removes **only generated artifacts in this Pi Voice checkout**; save a copy first if you need to restore the old native installation:

```bash
rm -rf -- .termux/build .termux/native
npm run termux:setup -- --source "../transcribe.cpp-$version"
export TRANSCRIBE_LIBRARY="$PWD/.termux/native/lib/libtranscribe.so"
```

The helper checks the source/header version against the installed binding and runs a no-model native smoke check. If upstream changes its C API, CMake options, install layout, or binding loader, adapt the helper and tests; do not bypass ABI checks or pretend Android is Linux. Keep `libtranscribe.so` and its matching `libggml*.so` siblings together.

## Validation checklist

From the merged checkout on Termux:

```bash
npm ci --ignore-scripts --include=optional
npm ls transcribe-cpp koffi
npm test
```

Rebuild as above if the native dependency changed or the library is missing. Then:

```bash
export TRANSCRIBE_LIBRARY="$PWD/.termux/native/lib/libtranscribe.so"
npm run termux:check
npm pack --dry-run --ignore-scripts
```

- Confirm package contents include `docs/`, setup/check scripts, and the audio modules, but exclude `.termux/` and `node_modules/`.
- Run the upstream test suite on a supported desktop platform too when shared audio/controller behavior changes. Termux tests do not prove desktop native capture works.
- With explicit microphone/model approval, manually check device selection, startup cancellation, recording/stop, and real transcription. Model downloads and recording are not part of the automated sync procedure.
- Report which checks actually ran. Unit tests and the no-model native check do **not** establish speech-recognition accuracy, performance, or successful inference with a real model.
