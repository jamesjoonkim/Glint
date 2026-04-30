---
title: First-Run Wizard — Local Model Download
date: 2026-04-30
status: draft
author: James Kim
---

# First-Run Wizard — Local Model Download

## Summary

Block-the-app onboarding flow that downloads the three local MLX models (text, vision, embed) on first launch, before the user can capture or chat. Required to make Glint installable as a `.app` bundle from GitHub Releases without forcing users to clone the repo and run `npm run dev`.

The wizard reuses the bundled `glint-mlx-server` PyInstaller binary in a new `--download` subcommand. Progress streams as JSON-lines from the Python child to the Electron main process to the React renderer. Per-model retry, network-resume via `huggingface_hub`, and a disk-space precheck cover the realistic failure modes.

## Goals

- A user who downloads the unsigned `Glint.app` from GitHub Releases can launch it once, click one button, wait, and have a working app — with no terminal, no Python, no `git clone`.
- Re-launches after a successful download are zero-friction (wizard never reopens).
- Mid-download failures (network drop, kill, crash) leave the app in a recoverable state — next launch resumes, doesn't redownload from scratch.
- Privacy contract preserved: only outbound calls are to `huggingface.co` during the wizard. After completion, app is airplane-mode capable.

## Non-Goals

- Custom CDN / mirror. We trust Hugging Face. If HF is down, the wizard fails gracefully and the user retries later.
- Bundling models inside the `.dmg`. Rejected (S346) — would push installer to ~13 GB.
- Letting users pick alternate models from the wizard. Model set is fixed in v1; settings UI handles overrides post-launch.
- Background / silent download. The user explicitly gates the download by clicking through.
- Model integrity layer beyond what `huggingface_hub` does internally. Files are SHA-verified per-shard by the library.

## Constraints

- **Apple Silicon only** — same as the rest of the app (MLX requirement).
- **macOS 13+** — same as the rest of the app.
- **`glint-mlx-server` already bundles `huggingface_hub`** (see `build/python/runtime.spec`) — no new Python dep.
- **Privacy ESLint rule** on `src/core/**` forbids `fetch`/`axios`. The downloader runs in Python (outside `core/`) and is invoked from `src/main/` (also outside `core/`), so the contract holds.
- **Existing wiring**:
  - `src/main/first-run.ts` already provides `isFirstRun()` / `markFirstRunComplete()` (flag-file at `~/Library/Application Support/Glint/.first-run-complete`).
  - `src/renderer/windows/FirstRun/index.tsx` already routed in `App.tsx` (placeholder UI).
  - `src/main/index.ts:540-541` is the **source of truth** for model `modelDir` names (`qwen2.5-7b-mlx`, `qwen3-vl-8b-mlx`).
  - `package.json#glint.models.vision` is **stale** (`Qwen2-VL-7B`) and must be corrected to `Qwen3-VL-8B-Instruct-4bit` as part of this work — the wizard reads the manifest.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  app boot (src/main/index.ts)                                   │
│    ├─ if GLINT_LLM=fake → markFirstRunComplete(), normal boot   │
│    ├─ isFirstRun() OR getMissingModels().length > 0?            │
│    │     YES → openFirstRunWindow(); skip hotkey reg, skip      │
│    │           runtime spawn; main window deferred              │
│    │     NO  → normal boot                                      │
└─────────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  FirstRun renderer (src/renderer/windows/FirstRun)              │
│  states: welcome → downloading → done | error                   │
└─────────────────────────────────────────────────────────────────┘
              ▲ IPC: model:download:progress / done / error
              │      firstRun:start / cancel / retry / status
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Main: src/main/model-installer.ts (NEW)                        │
│   spawns glint-mlx-server --download <repo> --dest <dir>        │
│   parses JSONL stdout → IPC events                              │
│   serial queue across the 3 models                              │
└─────────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Python: build/python/runtime_entry.py (MODIFY)                 │
│   if argv[1] == 'download': delegate to downloader.py           │
│  build/python/downloader.py (NEW)                               │
│   huggingface_hub.snapshot_download(repo, local_dir)            │
│   tqdm subclass → emit JSONL to stdout                          │
└─────────────────────────────────────────────────────────────────┘
```

Layer boundaries respected: Python download logic stays in `build/python/`, IPC plumbing stays in `src/main/`, renderer stays in `src/renderer/`. `src/core/` is untouched (download is a side-effect of orchestration, not a core domain concept).

## Components

### Python: `build/python/downloader.py` (NEW)

Single function `download(repo: str, dest: Path)` that:

1. Calls `huggingface_hub.snapshot_download(repo_id=repo, local_dir=dest, local_dir_use_symlinks=False, tqdm_class=JsonlTqdm)`.
2. Custom `JsonlTqdm` subclass overrides `update()` to print one JSON line per progress tick to stdout, flushed.
3. Emits sentinel events: `file_start`, `file_done`, `complete`, `error`.

Event schema (one JSON object per stdout line):

```json
{"event":"file_start","name":"model.safetensors","size":4200000000}
{"event":"progress","name":"model.safetensors","bytes":5242880,"total":4200000000}
{"event":"file_done","name":"model.safetensors"}
{"event":"complete","repo":"mlx-community/Qwen2.5-7B-Instruct-4bit"}
{"event":"error","msg":"connection reset","retryable":true}
```

Exit codes: `0` on `complete`, `1` on `error`.

### Python: `build/python/runtime_entry.py` (MODIFY)

Top-level `argv[1]` switch:

```python
if len(sys.argv) > 1 and sys.argv[1] == 'download':
    from downloader import main as download_main
    download_main(sys.argv[2:])
else:
    server_main(sys.argv[1:])
```

PyInstaller spec already includes `huggingface_hub` submodules — no spec change needed. Binary rebuild required once.

### Main: `src/main/model-installer.ts` (NEW)

Public API:

```ts
export type ModelSpec = { repo: string; localDir: string; sizeGB: number };
export type ProgressEvent =
  | { event: 'file_start'; name: string; size: number }
  | { event: 'progress'; name: string; bytes: number; total: number }
  | { event: 'file_done'; name: string }
  | { event: 'complete'; repo: string }
  | { event: 'error'; msg: string; retryable: boolean };

export class ModelInstaller {
  async start(specs: ModelSpec[]): AsyncIterable<{ spec: ModelSpec; ev: ProgressEvent }>;
  cancel(): void;
}
```

Internals: spawn `glint-mlx-server --download <repo> --dest <dir>` per spec, sequentially. Read stdout via `readline`. JSON.parse each line; malformed lines logged but don't crash. Emit IPC `model:download:progress` to the FirstRun window. On non-zero exit without `complete`, emit synthetic `error`.

### Main: `src/main/first-run.ts` (MODIFY)

Add:

```ts
export function getMissingModels(modelsRoot: string, manifest: ModelSpec[]): ModelSpec[];
```

Returns specs whose `localDir` does not exist OR contains no `*.safetensors`. Used at boot AND inside the wizard to drive what to download.

### Main: `src/main/windows/first-run.ts` (NEW)

`BrowserWindow` factory mirroring `settings.ts`. Fixed size (~640×480), non-resizable, no menu, frame-on. Loads renderer with `?view=first-run`. On close before completion: app quits (no zombie state).

### Main: `src/main/index.ts` (MODIFY)

Boot sequence change:

```ts
if (process.env.GLINT_LLM === 'fake') {
  await markFirstRunComplete();
} else {
  const missing = getMissingModels(modelsRoot, MANIFEST);
  if (await isFirstRun() || missing.length > 0) {
    await runFirstRunFlow(missing);   // opens window, awaits completion
    await markFirstRunComplete();
  }
}
// existing boot continues — register hotkeys, spawn runtimes, open main window
```

`runFirstRunFlow` returns when the renderer signals `firstRun:complete` (or rejects on user-quit).

### Preload: `src/preload/api.ts` (MODIFY)

Add to exposed API:

```ts
firstRun: {
  getStatus: () => Promise<{ models: ModelStatus[]; freeDiskGB: number }>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: (repo: string) => Promise<void>;
  onProgress: (handler: (ev: ProgressEvent & { repo: string }) => void) => void;
}
```

### Renderer: `src/renderer/windows/FirstRun/index.tsx` (REWRITE)

State machine:

```
welcome      ── click "Download (≈9.6 GB)" ──▶ downloading
downloading  ── all rows complete           ──▶ done
downloading  ── any row error               ──▶ stays in downloading,
                                                 row shows Retry
done         ── click "Open Glint"          ──▶ ipc.firstRun.complete()
```

Visual:

```
┌─────────────────────────────────────────────┐
│              Welcome to Glint               │
│                                             │
│   First, we'll download three local models. │
│   ~9.6 GB · runs entirely on your Mac       │
│                                             │
│   ◯ Qwen2.5-7B (text)        4.5 GB         │
│   ◯ Qwen3-VL-8B (vision)     5.0 GB         │
│   ◯ bge-small (embed)        130 MB         │
│                                             │
│   Free disk: 234 GB                         │
│                                             │
│             [ Download ]                    │
└─────────────────────────────────────────────┘
```

Downloading state: each row swaps the bullet for a progress bar showing `bytes/total` for the current file plus a small "n of m files" counter. On error: row turns brass-red with a `Retry` button.

### Manifest fix: `package.json`

```jsonc
"glint": {
  "models": {
    "text":   "mlx-community/Qwen2.5-7B-Instruct-4bit",
    "vision": "mlx-community/Qwen3-VL-8B-Instruct-4bit",  // was Qwen2-VL — STALE
    "embed":  "mlx-community/bge-small-en-v1.5-bf16"
  }
}
```

The wizard imports this at build time (Vite-inlined) so renderer and main agree on the set without a separate config file.

## Data flow

```
[renderer mount]
   ipc.firstRun.getStatus()
       ↓
[main]  reads MANIFEST + scans modelsRoot + queries `df`
       ↓
   { models: [{repo, sizeGB, present}], freeDiskGB }
       ↓
[renderer]  renders welcome screen
       ↓ user clicks Download
   ipc.firstRun.start()
       ↓
[main]  ModelInstaller.start([missing specs])
       ↓ spawn child #1
[python]  snapshot_download → JSONL
       ↓
[main]  parse line → ipc.send 'model:download:progress'
       ↓
[renderer]  update row state
       ↓ ... repeats for #2, #3
[main]  all complete → markFirstRunComplete()
       ↓ ipc.send 'firstRun:done'
[renderer]  show "Open Glint" → ipc.firstRun.complete()
       ↓
[main]  closes wizard window, opens main window, registers hotkeys
```

## Error handling

| Failure | Detection | Recovery |
|---|---|---|
| Network drop mid-download | Python emits `error` event, exits 1 | Renderer Retry button → re-spawns Python; `huggingface_hub` resumes from partial files |
| Disk full pre-start | `df` shows `<15 GB` free | Welcome screen disables Download, shows warning |
| Disk full mid-download | Python OS error → `error` event | Renderer toast "disk full"; Retry available after user frees space |
| User cancels | Renderer button → `firstRun.cancel()` | SIGTERM Python child; partial files left in place; Retry resumes |
| Repo 404 / HF outage | Python `error` event | Retry button (user can wait + retry) |
| Wizard window force-closed | Window `closed` event before `firstRun:complete` | Flag file NOT written → next launch reopens wizard. Idempotent. |
| Malformed JSONL line | `JSON.parse` throws in main | Logged, line dropped; download continues |
| PyInstaller binary missing | spawn ENOENT | Wizard shows fatal error: "Glint runtime missing — please reinstall" |

## Testing

| Test | Type | Asserts |
|---|---|---|
| `model-installer.test.ts` | unit (Vitest) | JSONL parser handles partial buffer reads, malformed lines, exit-without-complete is treated as error |
| `first-run.test.ts` | unit | `getMissingModels` returns correct subset based on dir presence + safetensors presence; empty dir counted as missing |
| `firstRun.fake-mode.test.ts` | unit | `GLINT_LLM=fake` short-circuits the gate, marks complete, never spawns wizard |
| Manual smoke | E2E | Wipe `~/Library/Application Support/Glint/models/`, launch packaged build, verify wizard flow on real network |
| Manual: kill mid-download | E2E | Verify partial files remain, relaunch resumes correctly |
| Manual: airplane mode after install | E2E | App boots, captures, chats with no network |

## Open follow-ups (NOT in this spec)

- Settings UI panel to switch model variants (e.g. 4-bit ↔ 8-bit). Roadmap.
- "I have models locally" import path for power users. Currently they can place files in `~/Library/Application Support/Glint/models/<dir>/` before first launch and the wizard skips that model.
- Auto-update host decision (still blocked per S346).
- Code signing + notarization (user-deferred per current task).

## Manual prerequisite

PyInstaller rebuild is required once after `downloader.py` and `runtime_entry.py` changes land:

```bash
bash build/python/build-runtime.sh
```

Takes ~5 minutes. The implementation plan flags this as a manual step before the wizard can be smoke-tested end-to-end.
