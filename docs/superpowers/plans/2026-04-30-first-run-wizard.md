# First-Run Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an onboarding wizard that downloads the three local MLX models on first launch so users can install Glint as a `.app` from GitHub Releases without cloning the repo.

**Architecture:** Reuse the bundled `glint-mlx-server` PyInstaller binary by adding a `--download` subcommand backed by a new `downloader.py` module. The Electron main process spawns it once per model, parses JSONL progress events from stdout, and forwards them via IPC to a React wizard window. Boot is gated until either `markFirstRunComplete()` has been written or the three model directories exist on disk.

**Tech Stack:** Python 3.11 + `huggingface_hub` (already bundled in PyInstaller spec), TypeScript / Node `child_process`, Electron `BrowserWindow` + `ipcMain`, React 18 + CSS Modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-30-first-run-wizard-design.md`

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `package.json` | MODIFY | Fix stale `glint.models.vision` manifest entry |
| `src/shared/models.ts` | NEW | Single-source-of-truth model manifest (repo, localDir, sizeGB) + `ProgressEvent` type imported by main + renderer |
| `src/main/first-run.ts` | MODIFY | Add `getMissingModels`, `getModelsRoot` |
| `src/main/model-installer.ts` | NEW | Spawn `glint-mlx-server --download`, parse JSONL stdout, IPC bridge |
| `src/main/windows/first-run.ts` | NEW | `BrowserWindow` factory for the wizard |
| `src/main/index.ts` | MODIFY | Boot gate — open wizard when first-run flag missing OR models missing |
| `src/preload/api.ts` | MODIFY | Allowlist new `firstRun:*` invoke channels and `firstRun:progress` push channel |
| `src/shared/ipc-channels.ts` | MODIFY | Register `firstRun.*` channels |
| `src/renderer/windows/FirstRun/index.tsx` | REWRITE | State machine: welcome → downloading → done / error |
| `src/renderer/windows/FirstRun/styles.module.css` | EXTEND | Progress rows, retry button, disk warning |
| `build/python/runtime_entry.py` | MODIFY | Route `argv[1] == "download"` to downloader |
| `build/python/downloader.py` | NEW | `huggingface_hub.snapshot_download` with JSONL progress |
| `tests/unit/first-run.test.ts` | NEW | `getMissingModels` behavior |
| `tests/unit/model-installer.test.ts` | NEW | JSONL parser handles partials, malformed lines, error events |

---

## Task 1 — Fix manifest + create shared model spec

**Files:**
- Modify: `package.json`
- Create: `src/shared/models.ts`

- [ ] **Step 1: Update `package.json#glint.models.vision`**

The current manifest is stale (says `Qwen2-VL-7B`). Truth lives in `src/main/index.ts:540-541`. Open `package.json` and change:

```jsonc
"glint": {
  "models": {
    "text": "mlx-community/Qwen2.5-7B-Instruct-4bit",
    "vision": "mlx-community/Qwen3-VL-8B-Instruct-4bit",
    "embed": "mlx-community/bge-small-en-v1.5-bf16"
  }
}
```

- [ ] **Step 2: Create `src/shared/models.ts`**

```ts
/**
 * Single source of truth for the local-model set. Imported by main
 * (boot gate, installer) and renderer (wizard UI). When the model
 * lineup changes, edit here and re-package.
 *
 * `localDir` is relative to `<appData>/Glint/models/` and matches the
 * directory layout the runtime spawn expects (see src/main/index.ts).
 */
export type ModelRole = 'text' | 'vision' | 'embed';

export type ModelSpec = {
  role: ModelRole;
  repo: string;
  localDir: string;
  /** Approximate on-disk size after download, in gigabytes. UI hint only. */
  sizeGB: number;
  /** Human-readable label for the wizard. */
  label: string;
};

export const MODEL_MANIFEST: readonly ModelSpec[] = [
  {
    role: 'text',
    repo: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    localDir: 'qwen2.5-7b-mlx',
    sizeGB: 4.5,
    label: 'Qwen2.5-7B (text)',
  },
  {
    role: 'vision',
    repo: 'mlx-community/Qwen3-VL-8B-Instruct-4bit',
    localDir: 'qwen3-vl-8b-mlx',
    sizeGB: 5.0,
    label: 'Qwen3-VL-8B (vision)',
  },
  {
    role: 'embed',
    repo: 'mlx-community/bge-small-en-v1.5-bf16',
    localDir: 'bge-small-en-v1.5-bf16',
    sizeGB: 0.13,
    label: 'bge-small (embed)',
  },
] as const;

export const MANIFEST_TOTAL_GB = MODEL_MANIFEST.reduce(
  (sum, m) => sum + m.sizeGB,
  0,
);

/**
 * JSONL events emitted by the Python downloader. Lives in `shared/`
 * because both `src/main/model-installer.ts` (parser, IPC sender) and
 * `src/renderer/windows/FirstRun/index.tsx` (reducer) consume it. Cross-
 * layer type import via `src/shared/` is the project's sanctioned path.
 */
export type ProgressEvent =
  | { event: 'file_start'; name: string; size: number }
  | { event: 'progress'; name: string; bytes: number; total: number }
  | { event: 'file_done'; name: string }
  | { event: 'complete'; repo: string }
  | { event: 'error'; msg: string; retryable: boolean };
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no references to the new file yet, but it must compile.

- [ ] **Step 4: Commit**

```bash
git add package.json src/shared/models.ts
git commit -m "feat(wizard): add model manifest source of truth + fix package.json"
```

---

## Task 2 — `getMissingModels` helper (TDD)

**Files:**
- Modify: `src/main/first-run.ts`
- Test: `tests/unit/first-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/first-run.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMissingModels } from '../../src/main/first-run.js';
import { MODEL_MANIFEST } from '../../src/shared/models.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'glint-models-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getMissingModels', () => {
  it('returns the full manifest when models dir is empty', () => {
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing).toHaveLength(MODEL_MANIFEST.length);
  });

  it('treats a present dir without safetensors as missing', () => {
    mkdirSync(path.join(root, MODEL_MANIFEST[0].localDir), { recursive: true });
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing.map((m) => m.role)).toContain(MODEL_MANIFEST[0].role);
  });

  it('treats a dir with at least one safetensors as present', () => {
    const dir = path.join(root, MODEL_MANIFEST[0].localDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing.map((m) => m.role)).not.toContain(MODEL_MANIFEST[0].role);
  });

  it('returns empty when all models present', () => {
    for (const m of MODEL_MANIFEST) {
      const dir = path.join(root, m.localDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
    }
    expect(getMissingModels(root, MODEL_MANIFEST)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/first-run.test.ts`
Expected: FAIL — `getMissingModels` is not exported from `src/main/first-run.ts`.

- [ ] **Step 3: Implement `getMissingModels` and `getModelsRoot`**

Replace the contents of `src/main/first-run.ts`:

```ts
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';
import type { ModelSpec } from '../shared/models.js';

const log = createLogger('first-run');

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Glint');
const FLAG_FILE = path.join(APP_SUPPORT, '.first-run-complete');
const MODELS_DIR = path.join(APP_SUPPORT, 'models');

export function getModelsRoot(): string {
  return MODELS_DIR;
}

export async function isFirstRun(): Promise<boolean> {
  try {
    await fs.access(FLAG_FILE);
    return false;
  } catch {
    return true;
  }
}

export async function markFirstRunComplete(): Promise<void> {
  await fs.mkdir(path.dirname(FLAG_FILE), { recursive: true });
  await fs.writeFile(FLAG_FILE, new Date().toISOString());
  log.info('first-run flag written');
}

/**
 * Returns the subset of the manifest whose local directory is missing or
 * empty of weight files. A weight file is anything matching `*.safetensors`
 * — partial downloads (e.g. interrupted by the user) leave only `.incomplete`
 * files behind, which we rightly treat as not-yet-installed.
 */
export function getMissingModels(
  modelsRoot: string,
  manifest: readonly ModelSpec[],
): ModelSpec[] {
  return manifest.filter((m) => {
    const dir = path.join(modelsRoot, m.localDir);
    if (!fsSync.existsSync(dir)) return true;
    const entries = fsSync.readdirSync(dir);
    return !entries.some((f) => f.endsWith('.safetensors'));
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/unit/first-run.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/first-run.ts tests/unit/first-run.test.ts
git commit -m "feat(wizard): add getMissingModels + getModelsRoot to first-run module"
```

---

## Task 3 — Python downloader module

**Files:**
- Create: `build/python/downloader.py`

This task is integration-tested manually in Task 11 (after PyInstaller rebuild). No vitest equivalent — Python code runs only inside the bundled binary.

- [ ] **Step 1: Create `build/python/downloader.py`**

```python
"""
Download a Hugging Face repo into a local directory, emitting one JSON
object per stdout line for the parent process to parse.

Usage (invoked by glint-mlx-server when argv[1] == "download"):
    glint-mlx-server download --repo <repo> --dest <dir>

Event schema:
    {"event": "file_start", "name": str, "size": int}
    {"event": "progress",   "name": str, "bytes": int, "total": int}
    {"event": "file_done",  "name": str}
    {"event": "complete",   "repo": str}
    {"event": "error",      "msg": str, "retryable": bool}

Exit codes:
    0 -> complete event emitted, all files on disk
    1 -> error event emitted (retryable or fatal — caller decides)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars
from tqdm.auto import tqdm


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


class JsonlTqdm(tqdm):
    """tqdm subclass that emits JSONL events instead of drawing a bar.

    huggingface_hub instantiates one tqdm per file with desc=<filename>.
    We surface file_start once, then progress events on each update, and
    file_done when the bar reaches `total` (or is closed).
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._last_emitted = 0
        self._announced_start = False

    def display(self, *_args: Any, **_kwargs: Any) -> None:
        # Suppress the default rendering — we don't want tqdm's bars
        # mixing into our JSONL stream.
        return

    def update(self, n: int = 1) -> bool | None:
        result = super().update(n)
        name = self.desc or "unknown"
        if not self._announced_start:
            _emit({"event": "file_start", "name": name, "size": int(self.total or 0)})
            self._announced_start = True
        # Throttle progress emits to ~once per 4 MiB to keep JSONL volume sane.
        if self.n - self._last_emitted >= 4 * 1024 * 1024 or self.n == self.total:
            _emit(
                {
                    "event": "progress",
                    "name": name,
                    "bytes": int(self.n),
                    "total": int(self.total or 0),
                }
            )
            self._last_emitted = self.n
        return result

    def close(self) -> None:
        if self._announced_start and self.n >= (self.total or 0):
            _emit({"event": "file_done", "name": self.desc or "unknown"})
        super().close()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="glint-mlx-server download")
    parser.add_argument("--repo", required=True, help="Hugging Face repo id")
    parser.add_argument("--dest", required=True, help="Local destination directory")
    args = parser.parse_args(argv)

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    # Disable the library's own progress UI so only our tqdm subclass speaks.
    disable_progress_bars()

    try:
        snapshot_download(
            repo_id=args.repo,
            local_dir=str(dest),
            local_dir_use_symlinks=False,
            tqdm_class=JsonlTqdm,
        )
    except Exception as err:  # noqa: BLE001 — we re-emit as a structured event
        retryable = not isinstance(err, (PermissionError, IsADirectoryError))
        _emit({"event": "error", "msg": str(err), "retryable": retryable})
        return 1

    _emit({"event": "complete", "repo": args.repo})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 2: Quick syntax check via the build venv (optional but cheap)**

Run:

```bash
build/python/.venv/bin/python -c "import ast; ast.parse(open('build/python/downloader.py').read()); print('OK')"
```

Expected: `OK`. If the venv does not exist yet, skip — Task 11 will rebuild it.

- [ ] **Step 3: Commit**

```bash
git add build/python/downloader.py
git commit -m "feat(wizard): add huggingface_hub downloader with JSONL progress"
```

---

## Task 4 — Wire `--download` subcommand into runtime entry

**Files:**
- Modify: `build/python/runtime_entry.py`

- [ ] **Step 1: Add the dispatch branch**

Replace the `main()` function in `build/python/runtime_entry.py` with:

```python
def main() -> None:
    args = sys.argv[1:]

    # Subcommand: download. Routes to downloader.py, bypasses server logic.
    if args and args[0] == "download":
        import downloader
        sys.exit(downloader.main(args[1:]))

    backend = "text"
    cleaned = []
    skip = False
    for i, arg in enumerate(args):
        if skip:
            skip = False
            continue
        if arg == "--backend" and i + 1 < len(args):
            backend = args[i + 1]
            skip = True
            continue
        cleaned.append(arg)

    _enforce_localhost(cleaned)
    sys.argv = [sys.argv[0], *cleaned]

    if backend == "vision":
        import vlm_server
        vlm_server.main()
    else:
        from mlx_lm.server import main as lm_main
        lm_main()
```

- [ ] **Step 2: Verify the spec includes `downloader` in PyInstaller bundle**

Open `build/python/runtime.spec`. Confirm `downloader` is reachable as a top-level module — it lives in the same directory as `runtime_entry.py`, so it ships automatically. If the `Analysis(...)` call lists explicit `[entry, ...]` files, add `'downloader.py'` to that list.

Read `build/python/runtime.spec` to confirm. If the entry list is `['runtime_entry.py', 'vlm_server.py']`, change to `['runtime_entry.py', 'vlm_server.py', 'downloader.py']`.

- [ ] **Step 3: Commit**

```bash
git add build/python/runtime_entry.py build/python/runtime.spec
git commit -m "feat(wizard): route 'download' subcommand to huggingface downloader"
```

---

## Task 5 — `model-installer.ts` (TDD)

**Files:**
- Create: `src/main/model-installer.ts`
- Test: `tests/unit/model-installer.test.ts`

The installer has two responsibilities: spawn the binary per spec and parse JSONL from stdout. The parser is pure and easy to test; the spawn path is tested in Task 11 manually.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/model-installer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { JsonlParser } from '../../src/main/model-installer.js';

describe('JsonlParser', () => {
  it('emits one event per complete line', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"file_start","name":"a","size":10}\n');
    expect(events).toEqual([{ event: 'file_start', name: 'a', size: 10 }]);
  });

  it('buffers partial lines until newline arrives', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"prog');
    p.feed('ress","name":"a","bytes":1,"total":10}\n');
    expect(events).toHaveLength(1);
    expect((events[0] as { event: string }).event).toBe('progress');
  });

  it('handles multiple events in one chunk', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed(
      '{"event":"file_start","name":"a","size":10}\n' +
        '{"event":"file_done","name":"a"}\n',
    );
    expect(events).toHaveLength(2);
  });

  it('drops malformed lines without throwing', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('not json\n{"event":"complete","repo":"r"}\n');
    expect(events).toEqual([{ event: 'complete', repo: 'r' }]);
  });

  it('flushes the trailing buffer on end()', () => {
    const events: unknown[] = [];
    const p = new JsonlParser((ev) => events.push(ev));
    p.feed('{"event":"complete","repo":"r"}'); // no trailing \n
    p.end();
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/model-installer.test.ts`
Expected: FAIL — `JsonlParser` not exported.

- [ ] **Step 3: Implement `model-installer.ts`**

Create `src/main/model-installer.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createLogger } from '../core/logger/index.js';
import type { ModelSpec, ProgressEvent } from '../shared/models.js';

const log = createLogger('model-installer');

export type { ProgressEvent };

/**
 * Splits a stream of stdout chunks into newline-delimited JSON objects.
 * Malformed lines are logged at debug and dropped — we never want a stray
 * tqdm message on stderr to crash the wizard.
 */
export class JsonlParser {
  private buffer = '';
  constructor(private readonly onEvent: (ev: ProgressEvent) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.parseLine(line);
    }
  }

  end(): void {
    if (this.buffer.length > 0) {
      this.parseLine(this.buffer);
      this.buffer = '';
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as ProgressEvent;
      this.onEvent(parsed);
    } catch {
      log.debug({ line: trimmed }, 'dropped malformed jsonl line');
    }
  }
}

export type InstallerCallbacks = {
  onProgress: (spec: ModelSpec, ev: ProgressEvent) => void;
  onModelDone: (spec: ModelSpec) => void;
  onModelError: (spec: ModelSpec, msg: string) => void;
  onAllDone: () => void;
};

/**
 * Installs the given specs serially. One running child at a time keeps the
 * UI's progress story simple: only one row is "active" at any moment.
 *
 * `binaryPath` points at the bundled glint-mlx-server. `modelsRoot` is the
 * directory each spec's `localDir` is resolved against.
 */
export class ModelInstaller {
  private current: ChildProcess | null = null;
  private cancelled = false;

  constructor(
    private readonly binaryPath: string,
    private readonly modelsRoot: string,
    private readonly callbacks: InstallerCallbacks,
  ) {}

  async start(specs: ModelSpec[]): Promise<void> {
    for (const spec of specs) {
      if (this.cancelled) return;
      await this.installOne(spec);
    }
    if (!this.cancelled) this.callbacks.onAllDone();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.current && this.current.exitCode === null) {
      this.current.kill('SIGTERM');
    }
  }

  private installOne(spec: ModelSpec): Promise<void> {
    return new Promise((resolve) => {
      const dest = path.join(this.modelsRoot, spec.localDir);
      const child = spawn(
        this.binaryPath,
        ['download', '--repo', spec.repo, '--dest', dest],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.current = child;

      let sawComplete = false;
      const parser = new JsonlParser((ev) => {
        if (ev.event === 'complete') sawComplete = true;
        if (ev.event === 'error') {
          this.callbacks.onModelError(spec, ev.msg);
        }
        this.callbacks.onProgress(spec, ev);
      });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => parser.feed(c));
      child.stderr?.on('data', (c: Buffer) =>
        log.debug({ repo: spec.repo, stderr: c.toString().trim() }, 'downloader stderr'),
      );

      child.on('exit', (code) => {
        parser.end();
        this.current = null;
        if (this.cancelled) {
          resolve();
          return;
        }
        if (sawComplete && code === 0) {
          this.callbacks.onModelDone(spec);
        } else {
          this.callbacks.onModelError(
            spec,
            `downloader exited with code ${code ?? 'null'}`,
          );
        }
        resolve();
      });

      child.on('error', (err) => {
        log.error({ err: String(err), repo: spec.repo }, 'spawn failed');
        this.callbacks.onModelError(spec, String(err));
        resolve();
      });
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/unit/model-installer.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/model-installer.ts tests/unit/model-installer.test.ts
git commit -m "feat(wizard): add JSONL parser + serial model installer"
```

---

## Task 6 — IPC channel registry

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/api.ts`

- [ ] **Step 1: Register `firstRun.*` channels**

Open `src/shared/ipc-channels.ts`. Add inside the `IPC` object:

```ts
  firstRun: {
    getStatus: 'firstRun:getStatus',
    start: 'firstRun:start',
    cancel: 'firstRun:cancel',
    retry: 'firstRun:retry',
    complete: 'firstRun:complete',
  },
```

- [ ] **Step 2: Allowlist push channels**

Open `src/preload/api.ts`. In the `PUSH_CHANNELS` set, add:

```ts
  'firstRun:progress',
  'firstRun:done',
  'firstRun:error',
```

(These are main → renderer pushes the wizard subscribes to.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/preload/api.ts
git commit -m "feat(wizard): register firstRun ipc channels"
```

---

## Task 7 — First-run BrowserWindow factory

**Files:**
- Create: `src/main/windows/first-run.ts`

- [ ] **Step 1: Create the factory**

```ts
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:first-run');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let firstRun: BrowserWindow | null = null;

export function openFirstRun(): BrowserWindow {
  if (firstRun && !firstRun.isDestroyed()) {
    firstRun.focus();
    return firstRun;
  }
  firstRun = new BrowserWindow({
    width: 640,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const url =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=first-run`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?view=first-run`;
  void firstRun.loadURL(url);
  firstRun.once('ready-to-show', () => firstRun?.show());
  firstRun.on('closed', () => (firstRun = null));
  log.info('first-run window opened');
  return firstRun;
}

export function closeFirstRun(): void {
  if (firstRun && !firstRun.isDestroyed()) firstRun.close();
}

export function getFirstRunWindow(): BrowserWindow | null {
  return firstRun;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/windows/first-run.ts
git commit -m "feat(wizard): add first-run BrowserWindow factory"
```

---

## Task 8 — Renderer FirstRun rewrite

**Files:**
- Rewrite: `src/renderer/windows/FirstRun/index.tsx`
- Extend: `src/renderer/windows/FirstRun/styles.module.css`

- [ ] **Step 1: Rewrite `index.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  MODEL_MANIFEST,
  MANIFEST_TOTAL_GB,
  type ModelSpec,
  type ProgressEvent,
} from '../../../shared/models.js';
import { IPC } from '../../../shared/ipc-channels.js';
import styles from './styles.module.css';

type RowState =
  | { kind: 'idle' }
  | { kind: 'downloading'; bytes: number; total: number; file: string }
  | { kind: 'done' }
  | { kind: 'error'; msg: string };

type Status = {
  models: { repo: string; localDir: string; present: boolean }[];
  freeDiskGB: number;
};

type View = 'welcome' | 'downloading' | 'done';

function pct(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((bytes / total) * 100));
}

export function FirstRun(): JSX.Element {
  const [view, setView] = useState<View>('welcome');
  const [status, setStatus] = useState<Status | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(MODEL_MANIFEST.map((m) => [m.repo, { kind: 'idle' as const }])),
  );

  useEffect(() => {
    void window.glint.invoke(IPC.firstRun.getStatus).then((s) => setStatus(s as Status));
    const off = window.glint.subscribe('firstRun:progress', (_e, payload) => {
      const { repo, ev } = payload as { repo: string; ev: ProgressEvent };
      setRows((prev) => ({ ...prev, [repo]: reduceRow(prev[repo], ev) }));
    });
    const offDone = window.glint.subscribe('firstRun:done', () => setView('done'));
    const offErr = window.glint.subscribe('firstRun:error', (_e, payload) => {
      const { repo, msg } = payload as { repo: string; msg: string };
      setRows((prev) => ({ ...prev, [repo]: { kind: 'error', msg } }));
    });
    return () => {
      off();
      offDone();
      offErr();
    };
  }, []);

  const diskWarning = useMemo(() => {
    if (!status) return null;
    return status.freeDiskGB < 15;
  }, [status]);

  const start = (): void => {
    setView('downloading');
    void window.glint.invoke(IPC.firstRun.start);
  };

  const retry = (repo: string): void => {
    setRows((prev) => ({ ...prev, [repo]: { kind: 'idle' } }));
    void window.glint.invoke(IPC.firstRun.retry, repo);
  };

  const finish = (): void => {
    void window.glint.invoke(IPC.firstRun.complete);
  };

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.title}>Welcome to Glint</h1>
      <p className={styles.subtitle}>
        First, we&rsquo;ll download three local models.
        <br />
        ~{MANIFEST_TOTAL_GB.toFixed(1)} GB · runs entirely on your Mac
      </p>

      <ul className={styles.rows}>
        {MODEL_MANIFEST.map((m) => (
          <Row key={m.repo} spec={m} state={rows[m.repo]} onRetry={() => retry(m.repo)} />
        ))}
      </ul>

      {status && (
        <p className={styles.disk}>
          Free disk: {status.freeDiskGB.toFixed(0)} GB
          {diskWarning && <span className={styles.warn}> · less than 15 GB free</span>}
        </p>
      )}

      <div className={styles.actions}>
        {view === 'welcome' && (
          <button
            className={styles.cta}
            disabled={diskWarning ?? false}
            onClick={start}
          >
            Download
          </button>
        )}
        {view === 'downloading' && <span className={styles.hint}>Downloading…</span>}
        {view === 'done' && (
          <button className={styles.cta} onClick={finish}>
            Open Glint
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  spec,
  state,
  onRetry,
}: {
  spec: ModelSpec;
  state: RowState;
  onRetry: () => void;
}): JSX.Element {
  return (
    <li className={styles.row}>
      <span className={styles.label}>{spec.label}</span>
      <span className={styles.size}>{spec.sizeGB.toFixed(2)} GB</span>
      <div className={styles.progress}>
        {state.kind === 'idle' && <span className={styles.idle}>·</span>}
        {state.kind === 'downloading' && (
          <div className={styles.bar}>
            <div
              className={styles.fill}
              style={{ width: `${pct(state.bytes, state.total)}%` }}
            />
          </div>
        )}
        {state.kind === 'done' && <span className={styles.done}>✓</span>}
        {state.kind === 'error' && (
          <button className={styles.retry} onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </li>
  );
}

function reduceRow(prev: RowState | undefined, ev: ProgressEvent): RowState {
  switch (ev.event) {
    case 'file_start':
      return { kind: 'downloading', bytes: 0, total: ev.size, file: ev.name };
    case 'progress':
      return { kind: 'downloading', bytes: ev.bytes, total: ev.total, file: ev.name };
    case 'file_done':
      // Stay in downloading until 'complete' arrives — multiple files per repo.
      return prev?.kind === 'downloading' ? prev : { kind: 'idle' };
    case 'complete':
      return { kind: 'done' };
    case 'error':
      return { kind: 'error', msg: ev.msg };
  }
}
```

Note: `window.glint` typing is provided by the existing preload contract; if the project does not yet declare `subscribe`/`invoke` globally, add the necessary `declare global` block at the top of this file mirroring the project's existing pattern (check `src/renderer/global.d.ts`).

- [ ] **Step 2: Extend the stylesheet**

Add to `src/renderer/windows/FirstRun/styles.module.css`:

```css
.wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 56px 48px 40px;
  min-height: 100vh;
  background: var(--ink-0, #0a0b0f);
  color: var(--paper-0, #e9e3d4);
  font-family: var(--font-serif, ui-serif, Georgia, serif);
}

.title {
  font-size: 28px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: -0.01em;
}

.subtitle {
  margin: 0 0 32px;
  text-align: center;
  color: var(--paper-2, #a99f8a);
  line-height: 1.5;
}

.rows {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
  width: 100%;
  max-width: 480px;
}

.row {
  display: grid;
  grid-template-columns: 1fr auto 96px;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ink-3, #1a2236);
}

.label { font-size: 14px; }
.size  { font-size: 12px; color: var(--paper-2, #a99f8a); font-variant-numeric: tabular-nums; }

.progress { justify-self: end; min-width: 96px; text-align: right; }

.bar {
  width: 96px;
  height: 6px;
  background: var(--ink-2, #11192a);
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--brass-0, #c9a96e);
  transition: width 120ms linear;
}
.idle { color: var(--paper-3, #6b6452); }
.done { color: var(--moss-0, #7bd389); font-weight: 700; }

.retry {
  font: inherit;
  font-size: 12px;
  background: transparent;
  color: var(--brass-0, #c9a96e);
  border: 1px solid var(--brass-0, #c9a96e);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
}
.retry:hover { background: var(--brass-0, #c9a96e); color: var(--ink-0, #0a0b0f); }

.disk { font-size: 12px; color: var(--paper-2, #a99f8a); margin: 0 0 24px; }
.warn { color: var(--rust-0, #d97757); }

.actions { display: flex; gap: 12px; }

.cta {
  font: inherit;
  font-size: 14px;
  background: var(--brass-0, #c9a96e);
  color: var(--ink-0, #0a0b0f);
  border: none;
  border-radius: 4px;
  padding: 10px 24px;
  cursor: pointer;
}
.cta:disabled { opacity: 0.4; cursor: not-allowed; }
.hint { color: var(--paper-2, #a99f8a); font-size: 13px; }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. If you hit `Cannot find name 'window.glint'`, mirror the global declaration used in another renderer window (e.g. `src/renderer/windows/Settings/index.tsx` or `global.d.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/windows/FirstRun/
git commit -m "feat(wizard): rewrite FirstRun renderer with welcome/downloading/done states"
```

---

## Task 9 — Main-process IPC handlers + boot gate

**Files:**
- Modify: `src/main/index.ts`

The wiring lives in two pieces: IPC handlers that the wizard talks to, and the boot-time gate that opens the wizard.

- [ ] **Step 1: Add helper imports + module state near the top of `src/main/index.ts`**

Locate the existing imports block. Add:

```ts
import { MODEL_MANIFEST } from '../shared/models.js';
import {
  isFirstRun,
  markFirstRunComplete,
  getMissingModels,
  getModelsRoot,
} from './first-run.js';
import { ModelInstaller } from './model-installer.js';
import { openFirstRun, closeFirstRun, getFirstRunWindow } from './windows/first-run.js';
import { statfs } from 'node:fs/promises';
```

(Some of these names already exist; merge into the existing import — do not add duplicates.)

Add module-scope state below the existing `textRuntime` block:

```ts
let installer: ModelInstaller | null = null;
let firstRunDeferred: { resolve: () => void; reject: (e: unknown) => void } | null = null;
```

- [ ] **Step 2: Add IPC handlers inside `wireIpc()`**

Locate `function wireIpc()`. Inside, add (style-match the existing handlers):

```ts
ipcMain.handle(IPC.firstRun.getStatus, async () => {
  const root = getModelsRoot();
  const missing = getMissingModels(root, MODEL_MANIFEST);
  let freeDiskGB = 0;
  try {
    const s = await statfs(os.homedir());
    // statfs returns bsize + bfree; Number safe for free-bytes well below 2^53.
    freeDiskGB = (Number(s.bsize) * Number(s.bfree)) / 1e9;
  } catch (err) {
    log.warn({ err: String(err) }, 'statfs failed; reporting 0 free');
  }
  return {
    models: MODEL_MANIFEST.map((m) => ({
      repo: m.repo,
      localDir: m.localDir,
      present: !missing.find((x) => x.repo === m.repo),
    })),
    freeDiskGB,
  };
});

ipcMain.handle(IPC.firstRun.start, async () => {
  const root = getModelsRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const missing = getMissingModels(root, MODEL_MANIFEST);
  await runInstaller(missing);
});

ipcMain.handle(IPC.firstRun.retry, async (_e, repo: unknown) => {
  if (typeof repo !== 'string') return;
  const spec = MODEL_MANIFEST.find((m) => m.repo === repo);
  if (!spec) return;
  await runInstaller([spec]);
});

ipcMain.handle(IPC.firstRun.cancel, () => {
  installer?.cancel();
});

ipcMain.handle(IPC.firstRun.complete, async () => {
  await markFirstRunComplete();
  closeFirstRun();
  if (firstRunDeferred) {
    firstRunDeferred.resolve();
    firstRunDeferred = null;
  }
});
```

`fs` is already imported at the top of `src/main/index.ts` as `import fs from 'node:fs'` (verify before editing). If only `fs/promises` is in scope, change to `await mkdir(root, { recursive: true })` and add `import { mkdir } from 'node:fs/promises'`.

- [ ] **Step 3: Add `runInstaller` helper below `wireIpc()`**

```ts
async function runInstaller(specs: ModelSpec[]): Promise<void> {
  if (specs.length === 0) {
    getFirstRunWindow()?.webContents.send('firstRun:done');
    return;
  }
  installer = new ModelInstaller(resolveRuntimeBinary(), getModelsRoot(), {
    onProgress: (spec, ev) => {
      getFirstRunWindow()?.webContents.send('firstRun:progress', { repo: spec.repo, ev });
    },
    onModelDone: (spec) => {
      log.info({ repo: spec.repo }, 'model installed');
    },
    onModelError: (spec, msg) => {
      getFirstRunWindow()?.webContents.send('firstRun:error', { repo: spec.repo, msg });
    },
    onAllDone: () => {
      getFirstRunWindow()?.webContents.send('firstRun:done');
    },
  });
  await installer.start(specs);
  installer = null;
}
```

Add `import type { ModelSpec } from '../shared/models.js';` to the imports.

- [ ] **Step 4: Insert the boot gate inside `app.whenReady().then(...)`**

Find the block (line ~606). Replace the body up to `wireIpc()` with this gated version:

```ts
app.whenReady().then(async () => {
  log.info('app ready');
  setPromptsDir(resolvePromptsDir());
  setMigrationsDir(resolveMigrationsDir());
  setSettingsPath(path.join(os.homedir(), 'Library', 'Application Support', 'Glint', 'settings.json'));
  await loadSettings();
  await openStore(resolveDbPath(), { nativeBinding: resolveBetterSqliteBinding() }).catch((err) =>
    log.error({ err: String(err) }, 'store open failed'),
  );
  registerAssetProtocolHandler(resolveCapturesDir());
  void backfillThumbnails().catch((err) => log.warn({ err: String(err) }, 'backfill failed'));

  wireIpc();

  const fakeMode = resolveLlmMode() === 'fake';
  const missing = getMissingModels(getModelsRoot(), MODEL_MANIFEST);
  const needsWizard = !fakeMode && ((await isFirstRun()) || missing.length > 0);

  if (needsWizard) {
    log.info({ missing: missing.map((m) => m.role) }, 'opening first-run wizard');
    openFirstRun();
    await new Promise<void>((resolve, reject) => {
      firstRunDeferred = { resolve, reject };
    });
  } else if (fakeMode) {
    await markFirstRunComplete();
  }

  // Existing boot continues — runtimes spawn AFTER the wizard completes
  // so they pick up freshly downloaded weights without a relaunch.
  textRuntimePromise = startNamedRuntime('text');
  visionRuntimePromise = startNamedRuntime('vision');
  void textRuntimePromise.then((h) => (textRuntime = h));
  void visionRuntimePromise.then((h) => (visionRuntime = h));
  createMainWindow();
  onResponseClosed(() => {
    purgeEmptyChatThreads();
    showMainWindow();
  });

  registerHotkeys(DEFAULT_BINDINGS, {
    onCapture: async () => {
      const { granted } = await ensureScreenRecording();
      if (!granted) return;
      openOverlay();
    },
    onChat: () => {
      const thread = createThread();
      hideMainWindow();
      const win = openResponse(`chat-${thread.id}`);
      const fire = () => {
        win.webContents.send('response:set-thread', { threadId: thread.id });
        win.webContents.send('response:replay', { threadId: thread.id });
      };
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', fire);
      } else {
        fire();
      }
    },
    onDashboard: () => {
      hideResponseWindow();
      purgeEmptyChatThreads();
      showMainWindow();
    },
    onHistory: () => openHistory(),
    onSettings: () => log.info('settings hotkey (P5)'),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
```

Key invariants this preserves:
- IPC is wired BEFORE the wizard opens, so the renderer can call `getStatus`.
- Runtimes spawn AFTER the wizard completes — picks up newly downloaded weights without an app restart.
- Hotkeys register AFTER the wizard, so users can't trigger captures with no model.

- [ ] **Step 5: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(wizard): gate boot on first-run wizard + wire ipc handlers"
```

---

## Task 10 — Fake-mode bypass test

**Files:**
- Modify: `tests/unit/first-run.test.ts`

This guards the dev workflow — `GLINT_LLM=fake npm run dev` must not pop the wizard.

- [ ] **Step 1: Add a test for the bypass logic**

The bypass lives inside the `app.whenReady` callback, which is hard to unit-test directly. Instead, codify the contract via a small extracted helper. Modify `src/main/first-run.ts` to add:

```ts
export type WizardGateInputs = {
  fakeMode: boolean;
  flagPresent: boolean;
  missingCount: number;
};

export function shouldOpenWizard(inputs: WizardGateInputs): boolean {
  if (inputs.fakeMode) return false;
  return !inputs.flagPresent || inputs.missingCount > 0;
}
```

Update `src/main/index.ts` to use it:

```ts
const fakeMode = resolveLlmMode() === 'fake';
const flagPresent = !(await isFirstRun());
const missing = getMissingModels(getModelsRoot(), MODEL_MANIFEST);
const needsWizard = shouldOpenWizard({
  fakeMode,
  flagPresent,
  missingCount: missing.length,
});
```

- [ ] **Step 2: Add the test cases**

Append to `tests/unit/first-run.test.ts`:

```ts
import { shouldOpenWizard } from '../../src/main/first-run.js';

describe('shouldOpenWizard', () => {
  it('skips wizard in fake mode regardless of state', () => {
    expect(shouldOpenWizard({ fakeMode: true, flagPresent: false, missingCount: 3 })).toBe(false);
  });
  it('opens wizard on first run', () => {
    expect(shouldOpenWizard({ fakeMode: false, flagPresent: false, missingCount: 0 })).toBe(true);
  });
  it('opens wizard when models missing even if flag present', () => {
    expect(shouldOpenWizard({ fakeMode: false, flagPresent: true, missingCount: 1 })).toBe(true);
  });
  it('skips wizard when flag present and all models present', () => {
    expect(shouldOpenWizard({ fakeMode: false, flagPresent: true, missingCount: 0 })).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- tests/unit/first-run.test.ts`
Expected: PASS — 4 new cases plus the 4 from Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/main/first-run.ts src/main/index.ts tests/unit/first-run.test.ts
git commit -m "feat(wizard): extract shouldOpenWizard predicate for fake-mode bypass"
```

---

## Task 11 — PyInstaller rebuild + manual smoke test

**Files:**
- None modified — verification only.

This is the gated step: the wizard cannot work end-to-end until the runtime binary includes `downloader.py`. Tell the user this is a manual step and they may want to set aside ~5 minutes.

- [ ] **Step 1: Rebuild the runtime**

Run:

```bash
bash build/python/build-runtime.sh
```

Expected: ends with `==> done: resources/runtime/glint-mlx-server (...)`. Build takes 3–5 minutes on M-series.

If `python3.11` is missing, install via `brew install python@3.11` and retry.

- [ ] **Step 2: Smoke-test the downloader directly**

Pick the smallest model and run the binary in download mode against a scratch dir:

```bash
mkdir -p /tmp/glint-test-dl
resources/runtime/glint-mlx-server download \
  --repo mlx-community/bge-small-en-v1.5-bf16 \
  --dest /tmp/glint-test-dl/bge
```

Expected: stream of JSONL lines on stdout (`file_start`, `progress`, `file_done`, `complete`). Exit code `0`. The dir `/tmp/glint-test-dl/bge/` contains `model.safetensors` plus tokenizer files.

- [ ] **Step 3: Wipe local state and run the wizard end-to-end**

```bash
mv ~/Library/Application\ Support/Glint/.first-run-complete{,.bak} 2>/dev/null
mv ~/Library/Application\ Support/Glint/models{,.bak}
npm run dev
```

Expected:
- Wizard window opens, shows three rows in idle state, free-disk and "Download" button.
- Clicking Download streams progress per row.
- On completion, "Open Glint" button appears.
- Clicking it closes the wizard and the main window opens.
- `~/Library/Application Support/Glint/.first-run-complete` exists.
- `~/Library/Application Support/Glint/models/qwen2.5-7b-mlx/` (and the other two) contain `*.safetensors`.

After confirming, restore the originals if you want your existing models back:

```bash
rm -rf ~/Library/Application\ Support/Glint/models
mv ~/Library/Application\ Support/Glint/models.bak ~/Library/Application\ Support/Glint/models
mv ~/Library/Application\ Support/Glint/.first-run-complete.bak ~/Library/Application\ Support/Glint/.first-run-complete 2>/dev/null
```

- [ ] **Step 4: Smoke-test the kill-resume path**

```bash
mv ~/Library/Application\ Support/Glint/models{,.bak}
npm run dev   # start download
# After ~30s, force-quit the app (⌘Q on the wizard window)
npm run dev   # relaunch
```

Expected: wizard reopens, partial files in `models/qwen2.5-7b-mlx/` are preserved, retrying resumes (huggingface_hub skips already-downloaded shards).

- [ ] **Step 5: Repackage the .app**

```bash
npm run package
cp -R out/Glint-darwin-arm64/Glint.app /Applications/Glint.app
xattr -cr /Applications/Glint.app
```

Open `/Applications/Glint.app` and confirm the wizard appears (after wiping local state once more if needed).

- [ ] **Step 6: Commit (binary blob excluded — runtime is gitignored)**

No code changes in this task; nothing to commit unless `runtime.spec` changed in Task 4.

---

## Self-review notes

- Spec coverage:
  - Architecture diagram ⇒ Tasks 7, 9
  - Components table ⇒ Tasks 1–9
  - Data flow ⇒ Tasks 5, 8, 9 (`runInstaller` + renderer reducer)
  - Error handling table ⇒ Task 5 (parser + installer error events) + Task 8 (UI states) + Task 9 (handlers)
  - Testing table ⇒ Tasks 2, 5, 10 (unit) + Task 11 (manual)
  - Manifest fix ⇒ Task 1
- IPC channel name `firstRun:complete` is a request-response invoke; `firstRun:done` is the push. They are intentionally distinct — the renderer may also reach `done` state mid-flow without firing `complete`.
- `JsonlParser` and `ModelInstaller` are exported as named classes — both unit-tested in isolation. Spawn-side behavior is covered manually in Task 11.
- `ProgressEvent` type is shared between main and renderer via a `type` import (no runtime cost).

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-first-run-wizard.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks. Best for an 11-task plan like this one.
2. **Inline Execution** — run tasks in this session with batch execution + checkpoints.

Which approach?
