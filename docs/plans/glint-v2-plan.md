---
title: Glint v2 — Implementation Plan
date: 2026-04-28
status: draft
spec: ../superpowers/specs/2026-04-28-glint-v2-design.md
target_branch: feature/v2-rebuild
total_days: 19 working days (solo)
---

# Glint v2 — Implementation Plan

**Value prop**: Local-first AI screenshot assistant for Apple Silicon Macs. ⌘⇧X to capture, AI explanation, multi-turn chat, searchable history. Zero cloud calls after first run.

**Spec reference**: [`docs/superpowers/specs/2026-04-28-glint-v2-design.md`](../superpowers/specs/2026-04-28-glint-v2-design.md)

## Stats

| Metric | Value |
|--------|-------|
| Build days | 19 (solo) |
| Phases | 6 (P0 → P5) |
| New files | ~58 source files + ~40 tests |
| Modified files | 0 (greenfield in same repo, old code deleted) |
| Reused from v1 | 4 patterns (tesseract config, marquee CSS, hotkey shape, response window UX) |
| Languages | TypeScript (strict), SQL, CSS Modules |
| Runtime targets | macOS 13+, Apple Silicon (M1/M2/M3) |

## Pre-Build Decisions (LOCKED)

The following are decided per the spec. Any deviation must update both spec and plan.

| Decision | Choice | Locked at |
|----------|--------|-----------|
| Platform | Mac-first (M-series only) | Q3 (clarification) |
| Runtime | Electron + Vite (`@electron-forge/plugin-vite`) | Q3 |
| LLM backend | MLX, sidecar `mlx_lm.server` on `localhost` | Architecture |
| Vision strategy | Hybrid OCR router (text-density classifier) | Q4 |
| Memory tier | Tier 1 — searchable history + threads | Q5 |
| Storage | SQLite + FTS5 + sqlite-vss in `~/Library/Application Support/Glint/` | Architecture |
| Embedding model | `mlx-community/bge-small-en-v1.5-mlx` (384-dim) | Models |
| Text LLM | `mlx-community/Qwen2.5-7B-Instruct-4bit` (~4 GB) | Models |
| Vision LLM | `mlx-community/Qwen2-VL-7B-Instruct-4bit` (~6 GB) | Models |
| MLX server port | Ephemeral (8765 default, fallback to OS-assigned) | Open Q resolved |
| Vision model | Optional download, skippable in first-run wizard | Open Q resolved |
| Auto-update | Omitted in v2.0 (manual download from Releases) | Open Q resolved |
| Python runtime | **Bundled** via PyInstaller — `mlx_lm` packaged into `resources/runtime/glint-mlx-server` (single signed binary, ~200MB after PyInstaller `--strip` + UPX) | Review iter 1 |
| Markdown rendering | Add `marked` (already in deps but unused in v1) + `DOMPurify` for XSS sanitize | Review iter 1 |
| Logger | Pino w/ rolling file in `~/Library/Application Support/Glint/logs/`. Never logs OCR text or PNG paths (PII) | Review iter 1 |
| Node version (dev) | Node 20 LTS (`.nvmrc` pinned) | Review iter 1 |
| Windows port | Out of scope for v2.0 | Spec |

## Repository Strategy

**Approach**: rebuild in same repo, on branch `feature/v2-rebuild`. Tag v1 final commit as `v1-final` for reference. After v2 ships, `main` becomes v2; v1 stays accessible via tag.

**Why same repo**: continuity of stars/issues/release artifacts. v1 is functional; users stay on it until v2 DMG ships.

```
main (v1)              ──── tag: v1-final
                        \
                         feature/v2-rebuild  ── all work happens here
                                              ── merge to main at v2.0 release
```

## Phase Breakdown

```
P0  Bootstrap                 Day 1-2     Forge+Vite, dirs, lint, HMR working
P1  Capture pipeline (text)   Day 3-7     hotkey → marquee → OCR → text-LLM → answer
P2  Vision route + router     Day 8-9     Qwen2-VL, density classifier, route dispatch
P3  Storage + history         Day 10-13   SQLite, FTS5, vss, search, history panel
P4  Threads + continuation    Day 14-16   multi-turn, continue/re-ask, auto-tag, titles
P5  First-run + packaging     Day 17-19   wizard, downloads, polish, DMG, smoke tests
```

---

## Phase 0 — Bootstrap (Day 1-2)

**Goal**: Working dev loop. Edit any file → see change in <2 seconds. Three-layer directory structure with import boundaries enforced. v1 source deleted in first commit on `feature/v2-rebuild` branch.

### Sequencing

```
Day 1 morning:  branch off main, tag v1 → `v1-final`
Day 1 morning:  delete v1 src/ entirely (commit: "chore: remove v1 sources")
Day 1 afternoon: scaffold P0 structure
Day 2:          dev loop verified, lint rules + tests stub passing
```

### v1 files deleted in P0 (first commit)

```
src/main.ts                        642 LOC god-file
src/main/main.ts                   duplicate entry
src/main/screenshot.ts             rewritten in P1 with cleaner shape
src/main/screenshot-handler.ts     merged into capture.ts
src/main/hotkey.ts                 keep contents as reference, file rewritten
src/main/logging.ts                replaced by pino logger
src/renderer.ts                    duplicate
src/renderer/renderer.ts           duplicate
src/renderer/screenshot.ts         marquee math triplicated — consolidate
src/renderer/App.tsx               full rewrite
src/renderer/index.tsx             rewritten as main.tsx
src/renderer/components/*          full rewrite (CSS Modules + new structure)
src/services/openai.ts             cloud LLM removed
src/services/screenshot.ts         absorbed into core/ pattern
src/services/logger.ts             replaced by pino
src/preload/screenshot.ts          rewritten as typed api.ts
src/config.ts                      env keys gone
src/types/screenshot.ts            shared types move to src/shared/types.ts
forge.config.js                    replaced by .ts
```

Saved as reference (do not delete from git history — `v1-final` tag preserves them).

### Files to create

```
glint/
├── .nvmrc                          Node 20 LTS pin
├── package.json                    rewrite from scratch (drop OpenAI dep, add MLX/sqlite stack)
├── forge.config.ts                 Forge w/ Vite plugin + DMG maker + notarize hook
├── vite.main.config.ts             main process Vite config
├── vite.preload.config.ts          preload Vite config
├── vite.renderer.config.ts         renderer Vite config
├── tsconfig.json                   strict mode, path aliases per layer
├── tsconfig.node.json              for Vite configs
├── vitest.config.ts                test config, paths, coverage
├── playwright.config.ts            E2E config for packaged Electron
├── .eslintrc.cjs                   + custom rule: no fetch/axios in core/**
├── .gitignore                      add models/, captures/, glint.db, resources/runtime/
├── migrations/
│   ├── .gitkeep                    (filled in P3)
│   └── README.md                   migration naming convention
├── src/
│   ├── main/
│   │   ├── index.ts                app lifecycle, window mgr bootstrap (~80 LOC)
│   │   └── windows/.gitkeep
│   ├── core/
│   │   ├── .gitkeep                (filled in P1)
│   │   └── logger/
│   │       └── index.ts            pino w/ rolling file, scrubs PII (~80 LOC)
│   ├── preload/
│   │   └── api.ts                  empty IPC scaffold (~30 LOC)
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx                React mount point (~20 LOC)
│   │   └── App.tsx                 placeholder (~30 LOC)
│   └── shared/
│       ├── types.ts                empty
│       └── ipc-channels.ts         channel name constants
├── prompts/                        empty dir, .gitkeep (filled in P1)
└── tests/
    ├── unit/
    │   └── logger.test.ts          PII scrubbing tests
    ├── integration/.gitkeep
    └── e2e/.gitkeep
```

### `forge.config.ts` detail (P0)

```ts
// forge.config.ts (sketch)
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerDMG } from '@electron-forge/maker-dmg';
import notarize from './build/notarize';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Glint',
    appBundleId: 'app.glint.macos',
    icon: 'resources/icon',                   // .icns auto-resolved
    osxSign: { identity: process.env.APPLE_DEV_ID_APPLICATION },
    osxNotarize: process.env.CI ? {
      appleId: process.env.APPLE_ID!,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
      teamId: process.env.APPLE_TEAM_ID!,
    } : undefined,
    extraResource: [
      'resources/runtime',                    // bundled Python+mlx-lm (P5)
      'resources/vss',                        // sqlite-vss arm64 dylib (P3)
    ],
  },
  makers: [
    new MakerDMG({ name: 'Glint', format: 'ULFO', overwrite: true }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/api.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
  hooks: { postMake: notarize },
};

export default config;
```

### Logger module (P0)

`src/core/logger/index.ts`:
- `pino` with daily rolling file at `~/Library/Application Support/Glint/logs/glint-<date>.log`
- 7-day retention
- Default level `info`; `debug` when `GLINT_DEBUG=1`
- **PII scrub**: redacts any string field matching keys `ocr_text`, `png_path`, `tags` to `<redacted>`
- Test coverage: scrub on synthetic log entries, file rotation logic, env-flag respect

### Files to delete (from v1)

```
src/main.ts                        (19KB god-file, replaced by src/main/index.ts)
src/main/main.ts                   (duplicate entry)
src/renderer.ts                    (duplicate)
src/renderer/renderer.ts           (duplicate)
src/services/openai.ts             (cloud LLM removed)
src/config.ts                      (env keys gone, config moves into core/models)
forge.config.js                    (replaced by .ts)
```

### v1 patterns to keep (reference, not import)

| v1 file | v2 destination | What's reused |
|---------|----------------|---------------|
| `src/main/screenshot.ts` | `src/main/capture.ts` | `desktopCapturer.getSources()` call shape, multi-display iteration via `screen.getAllDisplays()` |
| `src/main/hotkey.ts` | `src/main/hotkey.ts` | `globalShortcut.register` + cleanup-via-array pattern, `Cmd+Shift+X` keybind |
| `src/renderer/screenshot.ts` + `App.tsx` + `ScreenshotOverlay.tsx` | `src/renderer/components/SelectionOverlay/` | marquee math (consolidate triplicated `getSelectionStyle()` into ONE source) |
| `src/renderer/components/ResponseWindow.css` | `src/renderer/components/ResponseWindow/styles.module.css` | minimal-window styling, copy-button positioning, drag handle |
| `tesseract.js` config | `core/ocr/tesseract.ts` | worker init, language pack path, confidence threshold |

**NEW (not reused — must build):**
- Markdown rendering — `marked` is in v1 deps but **never imported**. v2 wires it into ResponseWindow + adds `DOMPurify` for XSS sanitize.
- Three-layer architecture (v1 was single-layer god-file)
- All IPC contract typing
- All persistence (v1 had `electron-store` only)

### Custom ESLint rule

`.eslintrc.cjs` adds rule blocking network primitives in `core/**`:

```js
overrides: [{
  files: ['src/core/**/*.ts'],
  rules: {
    'no-restricted-globals': ['error',
      { name: 'fetch', message: 'Network calls forbidden in core/. Use main/ services.' }
    ],
    'no-restricted-imports': ['error', {
      patterns: ['axios', 'node-fetch', 'undici', 'electron']
    }]
  }
}]
```

### Acceptance

- [ ] `npm run dev` starts Electron, renderer mounts blank React app
- [ ] Edit `src/renderer/App.tsx` → HMR reloads in <500ms (no quit/restart)
- [ ] Edit `src/main/index.ts` → main process auto-restarts in <2s
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` runs vitest (zero tests, but executes)
- [ ] `npm run test:e2e` packages app and Playwright opens it
- [ ] `import { something } from 'electron'` in a `core/**` file fails lint

### Tests in P0

- `tests/unit/sanity.test.ts` — confirms vitest runs (zero real coverage yet)

---

## Phase 1 — Capture pipeline, text route (Day 3-7)

**Goal**: ⌘⇧X → marquee select → tesseract OCR → if text-dense, text-LLM answer streams to window. End-to-end happy path on text-heavy captures (code, errors, articles).

### Files to create

```
src/main/
├── hotkey.ts                       register ⌘⇧X, ⌘⇧H (~60 LOC)
├── capture.ts                      bridge to desktopCapturer + crop (~150 LOC)
├── permissions.ts                  Screen Recording perm guard + deep-link (~80 LOC)
└── windows/
    ├── overlay.ts                  marquee BrowserWindow (~120 LOC)
    └── response.ts                 answer BrowserWindow (~150 LOC)

src/core/
├── ocr/
│   └── tesseract.ts                wrap tesseract.js worker (~80 LOC)
├── router/
│   └── density.ts                  text density classifier (~50 LOC)
└── models/
    ├── runtime.ts                  spawn/health/kill mlx_lm.server (~120 LOC)
    ├── client.ts                   HTTP client to localhost:<port> (~100 LOC)
    └── prompts.ts                  load /prompts/*.md, hot-reload in dev (~80 LOC)

src/renderer/
├── components/
│   ├── SelectionOverlay/
│   │   ├── index.tsx               marquee crop UI (~150 LOC)
│   │   └── styles.module.css
│   └── ResponseWindow/
│       ├── index.tsx               token stream container (~120 LOC)
│       ├── MarkdownView.tsx        marked + DOMPurify render (~80 LOC)
│       └── styles.module.css
├── hooks/
│   ├── useCapture.ts               IPC bridge to main (~60 LOC)
│   └── useStream.ts                streaming token consumer w/ rAF batching (~100 LOC)
└── lib/
    └── safeMarkdown.ts             marked + DOMPurify config (~40 LOC)

src/preload/api.ts                  expose typed IPC (capture, query) (~80 LOC)
src/shared/types.ts                 Capture, Turn, Thread, ModelRoute (~60 LOC)
src/shared/ipc-channels.ts          add capture.* and model.* channels (~30 LOC)

prompts/
├── answer-text.md                  text-route system prompt
└── answer-vision.md                placeholder for P2

tests/
├── unit/
│   ├── router-density.test.ts      classifier on fixture OCR strings
│   ├── prompts-loader.test.ts      hot-reload, missing file fallback
│   └── model-client.test.ts        HTTP shape, streaming parse, error retry
├── integration/
│   ├── ocr-tesseract.test.ts       real tesseract on fixture PNG
│   └── runtime-mlx.test.ts         spawn fake mlx_lm.server, verify lifecycle
└── e2e/
    └── capture-text.spec.ts        hotkey → mock OCR → mock LLM → response window
```

### Key implementation notes

**MLX runtime**: `runtime.ts` spawns the bundled `resources/runtime/glint-mlx-server` (PyInstaller binary wrapping `mlx_lm.server`). Args: `--model <path> --port <port> --host 127.0.0.1` (localhost-only bind). Health-checks `GET /v1/models`. Restart on crash with backoff (1s, 2s, 5s, then surface error). On app quit, sends SIGTERM + 3s grace + SIGKILL.

**Port selection**: try 8765, on EADDRINUSE bind to OS-assigned (port 0), persist chosen port in process state and surface to renderer via typed IPC `model.port`.

**Localhost-only**: `--host 127.0.0.1` ensures the server is never reachable from the LAN. Verified in tests by attempting connection from `0.0.0.0` (must fail).

**Streaming**: SSE-style. ModelClient yields tokens as async iterable. `useStream` hook accumulates into a buffer; markdown re-render is **batched via `requestAnimationFrame`** (one render per frame max, ~60fps) instead of one render per token. This keeps UI responsive when tokens arrive at >120/s.

**Hotkeys** (`main/hotkey.ts`): `⌘⇧X` capture, `⌘⇧H` history, `⌘,` Settings (registered when app focused; standard Mac convention). All three rebindable via Settings → Hotkeys (P5). On rebind, `globalShortcut.unregisterAll()` + re-register.

**Markdown rendering**: `lib/safeMarkdown.ts` configures `marked` with `gfm: true`, then pipes output through `DOMPurify.sanitize()` with allowed tags `['p', 'pre', 'code', 'h1'..'h6', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'blockquote', 'hr', 'br']`. Disallowed: `script`, `iframe`, `style`, event handlers, `javascript:` URLs. Test fixture includes adversarial markdown (`<script>`, `[click](javascript:alert)`, etc.).

**Image input validation** (DoS guard): `capture.ts` rejects PNGs >50 MB after capture (configurable). OCR input checked before tesseract call; reject + toast if exceeded. Vision input checked before model call; downscale to max 4096×4096 if exceeded.

**IPC channel allowlist**: `preload/api.ts` exposes a frozen object via `contextBridge.exposeInMainWorld('glint', api)`. Renderer can ONLY call channels listed in the allowlist; unknown invocations throw at preload layer. Channel names live in `src/shared/ipc-channels.ts` as a typed `const` enum, shared at compile time between main + preload + renderer. Test: attempt to call `glint.foo()` from renderer must throw "channel not allowed."

**Localhost binding test** (security): integration test attempts to connect to MLX server from `0.0.0.0:<port>`. Connection MUST be refused. Asserts `--host 127.0.0.1` flag is honored.

**Fake LLM mode**: `GLINT_LLM=fake` makes ModelClient return a fixture stream from `tests/fixtures/responses/*.txt`. Used by all E2E tests and dev iteration without weights loaded.

**Density classifier**: `text_density = (chars >= 2-letter words) / (image_width × image_height / 1000)`. Threshold `> 0.7` → text route. Below → vision (P2). Tunable constant in code, not config (KISS).

### Edge cases addressed

| Case | Handling |
|------|----------|
| Marquee selection 0×0 (single click) | Reject, dismiss overlay, no DB write |
| Marquee crosses display boundaries | Capture each display separately, stitch (handled in `capture.ts`) |
| Tesseract throws (corrupt PNG) | Catch, set `text_density=0`, fall through to vision route (in P2 — text-only fallback message in P1) |
| MLX server hasn't booted yet (cold app start) | Show "warming up…" toast, queue capture, dispatch when `/health` returns 200 |
| Streaming connection drops mid-answer | Surface partial answer, append "[connection lost]" footer, allow retry |
| ⌘⇧X pressed twice rapidly | Debounce 500ms, second press ignored if overlay already up |

### Acceptance

- [ ] ⌘⇧X opens transparent full-screen overlay on active display
- [ ] Marquee select shows preview rectangle, Esc cancels
- [ ] On release, overlay closes, response window opens at cursor position
- [ ] OCR runs in <500ms on a 1920×1080 capture
- [ ] Density classifier picks "text" route on a code screenshot, "vision" placeholder route otherwise
- [ ] In `GLINT_LLM=fake` mode, response window shows fixture answer streaming token-by-token
- [ ] In `GLINT_LLM=real` mode (manual test), Qwen2.5-7B answers a screenshot of TypeScript code
- [ ] App quit kills `mlx_lm.server` (verify with `pgrep mlx_lm` returns empty)
- [ ] Permission denial shows actionable modal with deep-link to System Settings
- [ ] Coverage of `core/router`, `core/models`, `core/ocr` ≥ 80%

---

## Phase 2 — Vision route (Day 8-9)

**Goal**: Image-heavy captures route to Qwen2-VL-7B. Router fully functional both directions.

### Files to create / extend

```
src/core/models/
└── client.ts                       extend with .vision() method (multipart)
└── runtime.ts                      extend to manage 2 model processes (text + vision)

prompts/
└── answer-vision.md                vision-route system prompt

tests/
├── unit/
│   └── router-density.test.ts      add vision-route fixtures (UI screenshots, charts, photos)
├── integration/
│   └── runtime-mlx-vision.test.ts  spawn vision model variant, verify image upload
└── e2e/
    └── capture-vision.spec.ts      hotkey → low-density image → vision route mock
```

### Key notes

**Two MLX servers or one?** MLX server can host one model per process. Run two child processes: one for text, one for vision. Total RAM ~10 GB resident. If user skipped vision model in wizard, vision-route requests fall back to text-route on OCR text only with a "vision model not installed — install via Settings" toast.

**Image upload**: vision endpoint accepts PNG bytes as base64 in OpenAI-compatible message format (`{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }] }`).

**Latency expectation**: 5-15s first token on M2. UI shows progress indicator (animated dots) while waiting.

### Acceptance

- [ ] Density < 0.7 capture routes to Qwen2-VL
- [ ] Both MLX processes started at app boot, both `/health` green
- [ ] Vision response streams the same way as text
- [ ] If vision weights missing, graceful fallback message + Settings deep-link
- [ ] Coverage of `core/models` ≥ 80%

---

## Phase 3 — Storage + history (Day 10-13)

**Goal**: Every capture persisted. ⌘⇧H opens history panel. Hybrid search (semantic + keyword) returns sub-100ms results at 10k captures.

### Files to create

```
src/core/
├── embed/
│   └── bge.ts                      BGE-small via MLX HTTP (~60 LOC)
├── history/
│   ├── migrations.ts               idempotent runner, pending → applied (~80 LOC)
│   ├── store.ts                    SQLite + FTS5 + vss CRUD (~250 LOC)
│   ├── search.ts                   hybrid rank: 0.4·BM25 + 0.6·cosine (~120 LOC)
│   └── thumbnails.ts               PNG → 256×256 thumb, cached (~80 LOC)

migrations/
└── 0001_init.sql                   captures, threads, turns, FTS5, vss
                                    (full schema from spec section "SQLite Schema")

src/main/
└── windows/history.ts              history panel BrowserWindow (~120 LOC)

src/renderer/
├── components/
│   └── HistoryPanel/
│       ├── index.tsx               grid + search + filters (~200 LOC)
│       ├── CaptureCard.tsx         single tile (~80 LOC)
│       ├── VirtualGrid.tsx         react-window wrapper (~60 LOC)
│       └── styles.module.css
├── hooks/
│   ├── useHistory.ts               search + filter state (~100 LOC)
│   └── useThumbnails.ts            IntersectionObserver lazy-load (~80 LOC)

src/shared/types.ts                 add SearchResult, HistoryFilter

tests/
├── unit/
│   ├── search-rank.test.ts         BM25 + cosine merge logic
│   └── store-crud.test.ts          insert / update / delete on tmp db
├── integration/
│   ├── store-fts.test.ts           FTS5 against fixture corpus
│   ├── store-vss.test.ts           vss KNN against synthetic vectors
│   └── search-perf.test.ts         seed 10k rows, assert query <100ms
└── e2e/
    └── history-panel.spec.ts       capture → quit → relaunch → search → result
```

### sqlite-vss extension loading

`better-sqlite3` is the chosen Node SQLite driver (sync API, electron-rebuild handled). `sqlite-vss` is loaded as a runtime extension via `db.loadExtension()` after locating the platform-specific `.dylib` shipped in `resources/`.

```ts
// store.ts excerpt
const vssPath = path.join(process.resourcesPath, 'vss', 'vss0.dylib');
db.loadExtension(vssPath);
```

For dev, `resources/vss/` is symlinked to `node_modules/sqlite-vss/.../vss0.dylib`.

### Schema

Per spec section "SQLite Schema". Migrations live in `migrations/0001_init.sql` etc. Runner reads `PRAGMA user_version` and applies anything newer.

### Edge cases

| Case | Handling |
|------|----------|
| DB file missing on first run | Migrations run automatically, create file |
| sqlite-vss extension fails to load (missing dylib) | Fatal — surface modal, app quits gracefully |
| Embedding service down (MLX not booted) | Save capture, mark `embed_pending=1`, retry on next boot |
| Search query empty | Show recent 50 captures by `created_at DESC` |
| FTS5 query parse error (e.g., user types `*foo`) | Strip special chars, retry; on second fail, fall back to substring `LIKE` |
| 10k+ captures grid scroll | Virtual scrolling via `react-window` (capped at ~50 DOM nodes via VirtualGrid) |
| Thumbnail PNG missing on disk (user moved it) | Show placeholder + warning icon |
| Thumbnail generation cost (10k full PNGs = slow render) | `thumbnails.ts` resizes captures to 256×256 on first save, caches in `captures/thumbs/<id>.webp`. Renderer reads thumbs, never the full PNGs in grid view. |
| Thumb load thrash on rapid scroll | `useThumbnails` uses `IntersectionObserver` w/ 100px rootMargin; only visible+near-visible thumbs decode. Max 30 concurrent decodes. |

### Acceptance

- [ ] Every ⌘⇧X persists row in `captures` + thread + first turn
- [ ] Thumbnail (256×256 webp) generated within 1s of save, stored in `captures/thumbs/`
- [ ] Embedding stored async after answer streams complete
- [ ] ⌘⇧H opens history panel in <100ms
- [ ] HistoryPanel renders 10k items with virtualized grid, only ~50 DOM nodes mounted
- [ ] Thumbnails lazy-load via IntersectionObserver; scrolling 10k items doesn't drop below 30fps
- [ ] Search "auth error" returns relevant past captures, ordered by hybrid score
- [ ] Search returns in <100ms at 10k seeded rows (perf test)
- [ ] Quit + relaunch → all history intact, search still works
- [ ] Keyboard navigation: arrow keys move selection in grid, Enter opens, Esc closes
- [ ] Each CaptureCard has `aria-label` summarizing date + tags + first 80 chars of OCR text
- [ ] Coverage of `core/history`, `core/embed` ≥ 80%

---

## Phase 4 — Threads + continuation (Day 14-16)

**Goal**: Multi-turn chat in response window. Click old capture → continue thread (default). ⌥-click → new thread on same image. Auto-tags + titles via LLM.

### Files to create / extend

```
src/core/
└── threads/
    ├── manager.ts                  CRUD on threads + turns (~100 LOC)
    ├── context.ts                  prompt assembly from spec section "Flow B" (~80 LOC)
    ├── titles.ts                   LLM-generated thread title (~60 LOC)
    └── tags.ts                     LLM auto-tag classifier (~60 LOC)

src/renderer/
├── components/
│   └── ResponseWindow/
│       ├── ChatReply.tsx           input + send (~80 LOC)
│       └── TurnList.tsx            scrollable turn history (~100 LOC)
├── hooks/
│   └── useThread.ts                load + append + stream (~120 LOC)

prompts/
├── classify.md                     auto-tag prompt (output: json array)
└── title.md                        thread-title prompt (output: ≤60 chars)

tests/
├── unit/
│   ├── thread-context.test.ts      prompt assembly: image + 3 turns + new msg
│   ├── tags-parser.test.ts         strict JSON parse, unknown tag rejection
│   └── titles.test.ts              length cap, profanity guard
├── integration/
│   └── continue-thread.test.ts     full cycle: capture → reply → quit → relaunch → continue
└── e2e/
    └── threads.spec.ts             plain-click vs ⌥-click flows
```

### Tag taxonomy (closed set)

```
code · error · article · ui · diagram · photo · chart · table · text · other
```

Classifier prompt outputs JSON array of 1-3 from this set. Unknown tags rejected (parser drops them). Captures with no recognizable tag get `["other"]`.

### Edge cases

| Case | Handling |
|------|----------|
| User replies before initial answer finishes streaming | Disable reply input until stream done |
| Thread title generation fails | Fall back to first 60 chars of OCR text |
| Tag classification fails (LLM returns malformed JSON) | Set `tags=["other"]`, log warning |
| ⌥-click from history opens fresh thread but model needs full PNG | Reload PNG from disk before dispatch |
| Continued thread is from yesterday + LLM context window can't fit all turns | Summarize older turns into a single "previous context" message via cheap text-LLM call |

### Acceptance

- [ ] Reply box appears in response window after first answer
- [ ] Send → new turn streams, persists, shows in TurnList
- [ ] Plain-click on history capture continues its thread (loads turns into ResponseWindow)
- [ ] ⌥-click on history capture starts new thread on same PNG
- [ ] Every saved capture has `tags` populated within 5s of save
- [ ] Every saved thread has `title` populated within 5s
- [ ] Long thread (15+ turns) doesn't exceed Qwen2.5 context window (uses summary fallback)
- [ ] Coverage of `core/threads` ≥ 80%

---

## Phase 5 — First-run wizard, Settings, packaging (Day 17-19)

**Goal**: Fresh M-series Mac → installed app → first capture working in <15 min. DMG signed + notarized. Settings window for re-running model downloads, hotkey rebinds, log access.

### Python runtime bundling (PyInstaller)

The largest infra task in P5. Steps:

```
build/python/
├── build-runtime.sh                builds glint-mlx-server binary
├── requirements.txt                pinned: mlx-lm, mlx-vlm, sentence-transformers
└── runtime.spec                    PyInstaller spec (one-file, --strip, --upx)
```

```bash
# build-runtime.sh
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt pyinstaller
.venv/bin/pyinstaller runtime.spec
codesign --deep --force --options runtime --sign "$APPLE_DEV_ID_APPLICATION" \
  dist/glint-mlx-server
mv dist/glint-mlx-server resources/runtime/
```

Outputs: signed `~200MB` self-contained binary. Run via `child_process.spawn(<path>, args)` — no Python on user's machine required.

**Codesigning gotcha**: PyInstaller binaries embed multiple Mach-O subbinaries (Python, native libs); each needs sign + entitlement. Tested via `codesign --verify --deep --strict`. Failure mode: Gatekeeper blocks runtime spawn, app shows "model service unavailable" toast.

### Files to create

```
src/main/
├── first-run.ts                    state machine for wizard (~120 LOC)
└── updater.ts                      OPTIONAL — leave stub, opt-in only (~40 LOC)

src/renderer/
├── windows/
│   ├── FirstRun/
│   │   ├── index.tsx               wizard root (~80 LOC)
│   │   ├── steps/
│   │   │   ├── Welcome.tsx         (~50)
│   │   │   ├── Permissions.tsx     (~80)
│   │   │   ├── DownloadModels.tsx  progress bars, resumable (~150)
│   │   │   └── Done.tsx            "press ⌘⇧X" (~40)
│   │   └── styles.module.css
│   └── Settings/
│       ├── index.tsx               settings root, tabbed (~100 LOC)
│       ├── tabs/
│       │   ├── Models.tsx          re-download, install vision, RAM check (~120)
│       │   ├── Hotkeys.tsx         rebind ⌘⇧X / ⌘⇧H (~80)
│       │   ├── Storage.tsx         disk usage, clear history, export (~100)
│       │   └── About.tsx           version, logs deep-link (~50)
│       └── styles.module.css
├── components/
│   └── ErrorToast/
│       ├── index.tsx               toast UI (~60 LOC)
│       └── styles.module.css
└── hooks/
    └── useDownload.ts              streaming HTTP download w/ resume (~120 LOC)

src/main/
└── downloads.ts                    HF Hub download driver (~140 LOC)

resources/
├── vss/                            sqlite-vss platform binary
│   └── vss0.dylib                  arm64 build
└── icon.icns                       app icon

build/
├── entitlements.mac.plist          screen recording entitlement
└── notarize.js                     post-make notarization hook

tests/
├── integration/
│   ├── first-run.test.ts           state machine transitions
│   └── download-resume.test.ts     simulate connection drop + resume
└── e2e/
    └── first-run.spec.ts           full wizard flow with mocked HF endpoint

forge.config.ts                     extend: dmg maker, signing config, notarize hook
```

### Code signing + notarization

- **Identity**: Apple Developer ID Application certificate (user-supplied via env vars `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
- **Entitlements**: `com.apple.security.device.camera` (no), `com.apple.security.network.client` (yes — for first-run download), `com.apple.security.files.user-selected.read-write` (yes — for export). NSScreenCaptureUsageDescription string in Info.plist.
- **Build target**: arm64 only (Apple Silicon constraint per spec)
- **Output**: `Glint-2.0.0-arm64.dmg`, signed + notarized + stapled

### Manual smoke checklist

```
On a fresh M-series Mac (no prior Glint install, no models, no perms granted):

☐ Mount DMG → drag to Applications
☐ Launch from Launchpad
☐ Welcome screen renders, fonts correct
☐ "Continue" → Screen Recording permission prompt fires
☐ Grant in System Settings → app detects, advances
☐ Model download starts at <expected size>, progress bar updates
☐ Cancel mid-download → resumable on retry
☐ Skip vision model → text-only mode confirmed in Settings
☐ Finish wizard → press ⌘⇧X
☐ Marquee a code screenshot → text-route answer streams
☐ Marquee a screenshot of UI → either vision-route streams OR fallback toast appears
☐ Type follow-up in reply box → continues thread
☐ ⌘⇧H → history panel shows both captures
☐ Search OCR text → result appears
☐ Quit app → `pgrep mlx_lm.server` empty
☐ Relaunch → no re-permission prompt, no re-download, ready instantly
☐ External display test: ⌘⇧X works on secondary monitor
☐ Light / dark mode rendering confirmed
☐ Airplane mode → app fully functional (no spinners, no errors)
```

### Acceptance

- [ ] DMG installs cleanly on M1, M2, M3
- [ ] First-run wizard completes in <15 min including downloads
- [ ] Settings window opens via `⌘,`; all 4 tabs render
- [ ] Settings → Models can re-download or remove a model
- [ ] Settings → Hotkeys rebinds ⌘⇧X to user choice; persists across launches
- [ ] Settings → Storage shows disk usage; "Clear history" button works with confirm modal
- [ ] Settings → Storage shows FileVault status; warns if disabled (since captures are PII-adjacent)
- [ ] Settings → About has "Open Logs" button → reveals log dir in Finder
- [ ] Manual smoke checklist 100% pass
- [ ] Unit + integration + E2E coverage ≥ 80%
- [ ] CI passes in <5 min (mocked LLM)
- [ ] Notarization ticket stapled, Gatekeeper passes
- [ ] No outbound network after first-run completion (verified with Little Snitch / Lulu)
- [ ] PyInstaller runtime binary signed + notarized + spawns cleanly on Gatekeeper-strict Mac

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation | Fallback |
|------|------------|--------|------------|----------|
| MLX runtime instability (Apple ML stack churn) | medium | high | Pin MLX version in `requirements.txt`, snapshot working model files | Bundle a known-good MLX commit hash; ship a "rollback runtime" toggle |
| Local vision quality below user expectations | high | medium | Set expectations in onboarding ("works best on text"). OCR-route handles 80% of cases well | Add opt-in "send to Claude API" button as v2.1, gated by user-supplied API key |
| sqlite-vss platform binary unavailable for arm64 | low | high | Verify availability before P3 starts | Switch to LanceDB (already evaluated) — adds 40 MB but maintained binaries |
| Hugging Face download speed slow / blocked | medium | medium | Resumable downloads, progress UI | Document mirror URLs in wizard, allow user to specify alternative |
| Screen Recording perm UX confusing | high | medium | Polished modal with screenshot of System Settings | Open System Settings deep-link automatically |
| Qwen2.5 context window overflow on long threads | medium | low | Auto-summarize older turns in `context.ts` | Cap thread length at 30 turns, warn user |
| First-run download interrupted | high | low | Resumable HTTP + checksum verification | "Continue download" on next launch |
| Code-signing cert expires mid-development | low | high | Renew before P5 | Ship unsigned with documented Gatekeeper override |
| User's M1 8GB Mac OOMs on vision model | medium | medium | Detect total RAM at install, gate vision model behind 16GB | Offer Qwen2-VL-2B variant (smaller, lower quality) as fallback |
| Tesseract.js worker crashes on weird captures | low | low | try/catch + fall through to vision route | Log + show "OCR failed, using vision" toast |

## Reuse Inventory (from v1)

| Pattern | v1 location | v2 destination | Reuse type |
|---------|-------------|----------------|------------|
| desktopCapturer + display iteration | `src/main/screenshot.ts` | `src/main/capture.ts` | reference, rewrite |
| globalShortcut registration | `src/main/hotkey.ts` | `src/main/hotkey.ts` | direct port |
| Marquee selection math | `src/renderer/screenshot.ts` | `src/renderer/components/SelectionOverlay/` | direct port, refactor to React |
| Response window CSS aesthetic | `src/renderer/components/ResponseWindow.css` | new CSS Module | port styles, replace inline w/ module |
| `marked` markdown rendering | dep already in v1 | same dep, used in ResponseWindow | direct |
| `tesseract.js` OCR | dep already in v1 | extracted into `core/ocr/tesseract.ts` | wrap, no rewrite |
| `electron-store` for prefs | `electron-store` v8 | drop — SQLite handles all state | replace |

## Verification Checklist

### Manual

```
☐ ⌘⇧X works on every monitor
☐ Marquee Esc cancels cleanly
☐ Code screenshot answers in <5s on M2
☐ UI screenshot answers in <20s on M2
☐ Reply box continues conversation
☐ ⌘⇧H opens history
☐ Plain-click old capture continues thread
☐ ⌥-click old capture starts new thread
☐ Search returns relevant results
☐ Search performant at 10k captures (<100ms)
☐ Quit cleans up MLX processes
☐ Airplane mode works post-first-run
☐ Light + dark mode render correctly
☐ External display capture works
☐ Permission re-grant not required after upgrade (signed build only)
☐ DMG installs on fresh Mac without dev tools
```

### Automated

```
☐ npm run typecheck — zero errors
☐ npm run lint — zero errors (incl. core/ network ban)
☐ npm test — coverage ≥ 80% per file in core/
☐ npm run test:e2e — all Playwright specs pass
☐ CI pipeline runs in <5 min
☐ No fetch/axios/electron imports in core/** (lint enforced)
☐ No console.log in src/** (replaced with logger.ts)
☐ All TypeScript files <800 LOC (per coding rules)
☐ All functions <50 LOC (manual code review pre-merge)
```

## CI Configuration

`.github/workflows/ci.yml` runs on every PR and push to `feature/v2-rebuild`:

```yaml
# sketch
on: [pull_request, push]
jobs:
  test:
    runs-on: macos-14         # M-series runner (Apple Silicon)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test -- --coverage
      - run: npm run test:e2e        # Playwright on Electron
        env: { GLINT_LLM: fake, GLINT_OCR: fake }
      - uses: codecov/codecov-action@v4
        with: { files: coverage/lcov.info, fail_ci_if_error: true }
```

**No real model in CI** — test runs use `GLINT_LLM=fake`. Real-model smoke test runs in a separate manual workflow `release-smoke.yml` triggered before each release tag.

## Phase Rollback Strategy

If a phase blocks on infra (e.g., MLX 1.x breaks Qwen2-VL, or PyInstaller can't sign), each phase has an escape hatch:

| Phase | Rollback if blocked |
|-------|---------------------|
| P0 | (no rollback — bootstrap is foundational) |
| P1 | If MLX fails: ship v2 in "OCR + display only" mode, no LLM. Useful for memory/search alone. |
| P2 | If vision model fails on MLX: skip vision route entirely; OCR path covers 80% of captures. Vision becomes v2.1. |
| P3 | If sqlite-vss arm64 binary unavailable: fall back to LanceDB (40MB extra, works on arm64). Adapter pattern in `store.ts` keeps swap easy. |
| P4 | If thread context overflow logic fails: hard-cap threads at 10 turns, no summarization. |
| P5 | If PyInstaller signing fails: ship unsigned with documented Gatekeeper override + warning toast. v2.0.1 fixes signing. |

## Dependency Order

```
P0 ──┐
     │
     ▼
P1 ──┐                              text route works without P2
     │
     ▼
P2 ──┐                              vision route works without P3
     │
     ▼
P3 ──┐                              history works without P4 (no continue)
     │
     ▼
P4 ──┐                              continue works without P5 (no wizard)
     │
     ▼
P5                                  ships
```

Phases ship in order. Branches:
- `feature/v2-rebuild` — long-lived integration branch
- `feature/v2-p<N>-<topic>` — short-lived feature branches off integration
- Each phase merged into integration after acceptance criteria pass
- `feature/v2-rebuild` merged to `main` only at v2.0.0 release

## Out-of-Scope Confirmations (per spec)

- ❌ Always-on screen recording
- ❌ Cloud LLM fallback
- ❌ Audio capture
- ❌ Windows port
- ❌ Knowledge base / RAG
- ❌ Personalization / learned preferences
- ❌ Auto-update (v2.0; opt-in considered for v2.1)
- ❌ Telemetry / crash reporting (opt-in only, never default)

## Acceptance — Plan Complete When

- All 6 phases shipped per their checklists
- DMG signed + notarized
- README rewritten for v2
- Release notes drafted
- v1 tagged as `v1-final` for fallback
- v2.0.0 GitHub Release published
