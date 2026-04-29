---
title: Glint v2 — Local-First Screenshot Assistant
date: 2026-04-28
status: draft
author: James Kim
---

# Glint v2 — Local-First Screenshot Assistant

## Summary

Rebuild Glint from scratch as a Mac-first, fully local desktop screenshot assistant. Trigger with `⌘⇧X`, marquee-select any region, get an AI explanation. Multi-turn chat refinement in the response window. Local history with semantic search, auto-tags, thumbnail grid, and conversation continuation.

**Zero third-party calls after one-time model download. Zero per-use cost. Zero data leak.**

v1 was a one-night Electron build using GPT-4V via OpenAI cloud. v2 abandons that model: local LLMs (MLX runtime), local OCR (tesseract.js — already in v1), local memory (SQLite + sqlite-vss). Architecture is split into Main (Electron orchestration), Core (pure TypeScript logic, framework-free), and Renderer (React UI).

## Goals & Non-Goals

### Goals

- **Privacy by construction.** No telemetry, no auto-update probes, no cloud LLM calls. After model download completes, the app must function airplane-mode.
- **Quality on text-heavy captures.** 80% of real captures are code, errors, articles. OCR-first router path makes these fast (1-3s) and lossless.
- **Quality on visual captures.** UI screenshots, diagrams, photos go through local vision model (Qwen2-VL-7B).
- **Memory that compounds.** Every capture searchable forever via semantic + keyword hybrid. Threads continue across sessions.
- **Distraction-free UX.** Single hotkey to capture, single hotkey to recall. Response window includes chat reply for refinement. No always-on screen recording (intentional capture only).

### Non-Goals (v2.0)

- Always-on screen recording (Screenpipe/Rewind territory — explicit not surveillance is a feature).
- Cloud fallback. No "send to GPT-4 if local fails" button. Pure local is the product.
- Audio capture. Out of scope for v2.0.
- Cross-platform Windows port. v1 was multi-platform; v2 is Mac-first to ship faster. Windows is post-1.0.
- Knowledge base / RAG over user docs. Roadmap as v2.2.
- Learned preferences / personalization. Roadmap as v2.3.

## Constraints

- **Hardware**: Apple Silicon (M1+) only for v2.0. MLX runtime requires it. 16GB RAM minimum (vision model holds ~6GB resident).
- **macOS**: 13.0+ (ScreenCaptureKit support).
- **Disk**: ~12GB after first run (Qwen2.5-7B ~4GB + Qwen2-VL-7B ~6GB + BGE-small ~30MB + SQLite + captures grow over time).
- **First-run network**: Required once for model download from Hugging Face. After that, fully offline.

## Architecture

Three layers, separated by import boundary:

```
┌─────────────────────────────────────────────────────────────────┐
│  RENDERER (React, UI only — no business logic)                  │
│                                                                 │
│  SelectionOverlay   ResponseWindow         HistoryPanel         │
│  (marquee crop)     (answer + chat)        (grid + search)      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ typed IPC (preload/api.ts)
┌──────────────────────────────▼──────────────────────────────────┐
│  MAIN (Electron — orchestration only)                           │
│                                                                 │
│  HotkeyMgr · WindowMgr · CaptureSvc · PermissionsGuard          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ in-process calls (zero network)
┌──────────────────────────────▼──────────────────────────────────┐
│  CORE (pure TS, framework-free, unit-testable in plain node)    │
│                                                                 │
│  OCRSvc ─→ Router ─→ ModelClient ──→ ThreadMgr                  │
│              │              │                │                  │
│              │              ▼                ▼                  │
│              │         MLX runtime      HistoryStore            │
│              │         (mlx_lm.server)  (sqlite + FTS5 + vss)   │
│              ▼                                                  │
│         EmbedSvc (BGE-small) ──→ HistoryStore (vectors)         │
└─────────────────────────────────────────────────────────────────┘
```

### Architectural decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Three layers: Main · Core · Renderer | v1 mixed all three in `main.ts` (19KB god-file). Separation enables unit testing and clear ownership. |
| 2 | Core has **zero Electron imports** | Run unit tests in plain node. No Electron stubs or harness needed. |
| 3 | MLX as **sidecar HTTP server** (`mlx_lm.server`) | Spawn-once at app boot keeps weights in unified memory. Per-request spawn would reload weights every call (5-10s). HTTP is OpenAI-compatible. |
| 4 | **sqlite-vss** over LanceDB | One file, one process. ~50ms semantic search at 10k captures is sufficient. LanceDB adds a daemon + binary deps for marginal gain at our scale. |
| 5 | Prompts in `/prompts/*.md`, hot-loaded at runtime | Edit prompt without rebuild. v1 hardcoded prompts in TS source. |
| 6 | Typed IPC contract in `preload/api.ts` | Renderer + Main share TS types compile-time. v1 used untyped channel name strings. |
| 7 | Hybrid OCR router | Tesseract first (free, fast, lossless on text). Density classifier picks text path or vision path. Vision only invoked when capture is image-heavy. |
| 8 | Mac-first, drop Windows for v2.0 | v1 cross-build was a maintenance tax. Ship v2 on Mac in weeks, port later. |

## Module Layout

File budget: 200-400 LOC ideal, 800 max (per global coding rules).

```
glint/
├── src/
│   ├── main/                       Electron main
│   │   ├── index.ts                lifecycle           ~80
│   │   ├── hotkey.ts               ⌘⇧X · ⌘⇧H          ~60
│   │   ├── capture.ts              ScreenCaptureKit    ~150
│   │   ├── permissions.ts          perms guard         ~80
│   │   └── windows/
│   │       ├── overlay.ts          marquee             ~120
│   │       ├── response.ts         answer window       ~150
│   │       └── history.ts          history panel       ~120
│   │
│   ├── core/                       pure logic
│   │   ├── ocr/tesseract.ts        wraps tesseract.js  ~80
│   │   ├── router/density.ts       text vs vision      ~50
│   │   ├── models/
│   │   │   ├── runtime.ts          spawn mlx_lm.server ~120
│   │   │   ├── client.ts           HTTP→localhost      ~100
│   │   │   └── prompts.ts          load from /prompts  ~80
│   │   ├── embed/bge.ts            BGE-small via MLX   ~60
│   │   ├── history/
│   │   │   ├── schema.sql          migrations
│   │   │   ├── store.ts            sqlite + FTS5 + vss ~250
│   │   │   └── search.ts           hybrid rank         ~120
│   │   └── threads/
│   │       ├── manager.ts          CRUD                ~100
│   │       └── context.ts          prompt assembly     ~80
│   │
│   ├── preload/api.ts              typed IPC           ~80
│   │
│   ├── renderer/                   React + CSS modules
│   │   ├── App.tsx                                     ~50
│   │   ├── components/
│   │   │   ├── ResponseWindow/     answer + chat
│   │   │   ├── HistoryPanel/       grid · search
│   │   │   └── SelectionOverlay/   marquee
│   │   ├── hooks/
│   │   │   ├── useCapture.ts
│   │   │   ├── useThread.ts
│   │   │   └── useHistory.ts
│   │   └── styles/                 .module.css ONLY (no inline)
│   │
│   └── shared/
│       ├── types.ts                shared TS types
│       └── ipc-channels.ts         channel name constants
│
├── prompts/                        editable, no rebuild
│   ├── classify.md                 text-density labeling
│   ├── tag.md                      auto-tag prompt
│   ├── answer-text.md
│   └── answer-vision.md
│
└── tests/
    ├── unit/                       core/
    ├── integration/                ipc + storage
    └── e2e/                        playwright
```

## Features

### v2.0 Ship List (MVP)

| Feature | What it does |
|---------|--------------|
| `⌘⇧X` capture | Marquee-select region, get AI answer in floating window |
| Multi-turn chat | Reply box in response window. Persists to thread. |
| `⌘⇧H` history | Open history panel. Visual grid of past captures. |
| Hybrid search | Semantic + keyword. Searches OCR text, answer text, tags. |
| Auto-tags | LLM classifies each capture: code · error · article · ui · diagram · photo |
| Continue thread | Click old thread, ask follow-up — agent has full prior context |
| Re-ask | Click old capture, start fresh thread on same image |
| Hybrid OCR router | Tesseract first; route to text-LLM if text-dense, vision-LLM if image-heavy |

### v2.1 Roadmap (post-MVP)

- Timeline view (by day/week)
- Image similarity search (CLIP embeddings)
- Pin/star important captures
- Export to markdown / Notion
- "On this day" surfacing
- Daily digest of captures

### v2.2+ (research only)

- Knowledge base / RAG over user-supplied docs
- Learned preferences / personalization
- Windows port

## Data Flows

### Flow A: Capture → Response (hot path)

```
⌘⇧X pressed
    │
    ▼
HotkeyMgr ──IPC──▶ overlay window (full-screen, transparent)
                        │
                        ▼ user marquee-selects region
                   CaptureSvc ──→ ScreenCaptureKit ──→ PNG buffer
                        │
                        ▼  (PNG + bbox)
                   OCRSvc (tesseract.js)
                        │
                        ▼  text + confidence + char_count
                   Router (density.ts)
                        │
            ┌───────────┴───────────┐
       text >70%                 image
            │                       │
            ▼                       ▼
     load /prompts/         load /prompts/
     answer-text.md         answer-vision.md
            │                       │
            ▼                       ▼
     ModelClient.text        ModelClient.vision
     POST localhost:8765    POST localhost:8765
     (Qwen2.5-7B)           (Qwen2-VL-7B)
            │                       │
            └───────────┬───────────┘
                        ▼ stream tokens
                  ResponseWindow opens
                  (markdown rendered live)
                        │
                        ▼ on completion
                  HistoryStore.save(thread, capture, answer)
                        │
                        ▼ async, non-blocking
                  EmbedSvc → store vector + auto-tag
```

### Flow B: Chat Reply in Response Window

```
user types follow-up
    │
    ▼
ThreadMgr.appendUserMessage(threadId, text)
    │
    ▼
ThreadMgr.context(threadId)  ──▶  assembles:
    [original PNG (if vision thread) or OCR text,
     all prior turns,
     new user turn]
    │
    ▼
ModelClient.<route> (same router output as initial)
    │
    ▼ stream
ResponseWindow appends + HistoryStore.save(turn)
```

### Flow C: History Search (`⌘⇧H`)

```
user types "that auth error from last week"
    │
    ▼
search.ts runs hybrid:
    │
    ├─→ FTS5 keyword on (ocr_text, answer_text, tags)
    │       returns rowids + bm25_score
    │
    ├─→ EmbedSvc(query) → 384-dim
    │       sqlite-vss KNN over capture_vec
    │       returns rowids + cosine_score
    │
    └─→ rerank: 0.4·bm25 + 0.6·cosine, dedupe, top 50
          │
          ▼
    HistoryPanel renders grid:
      thumb · tags · time · snippet · score
```

### Flow D: Continue / Re-ask on Old Capture

**Default action on click**: continue thread (most common intent — reopen and add a follow-up).
**Modifier**: `⌥`-click (Option) starts a new thread on the same image.

```
user clicks capture in HistoryPanel
    │
    ├── plain click       → "continue thread" (default)
    │                         load thread, open ResponseWindow w/ history
    │                         next message uses ThreadMgr.context()
    │
    └── ⌥-click           → "ask new"
                              load PNG + OCR, fresh thread, same pipeline
```

## Storage

**Path**: `~/Library/Application Support/Glint/`

```
Glint/
├── glint.db              SQLite (metadata, FTS5, vectors)
├── captures/             PNGs, named by capture id
│   ├── <uuid>.png
│   └── ...
├── models/               LLM weights (downloaded once)
│   ├── qwen2.5-7b-mlx/
│   ├── qwen2-vl-7b-mlx/
│   └── bge-small-en-v1.5-mlx/
└── logs/                 rolling logs, no PII (no OCR text)
```

### SQLite Schema

```sql
-- captures: one row per ⌘⇧X event
CREATE TABLE captures (
  id          TEXT PRIMARY KEY,            -- uuid v7
  created_at  INTEGER NOT NULL,            -- unix ms
  png_path    TEXT NOT NULL,               -- relative: captures/<id>.png
  ocr_text    TEXT,                        -- tesseract output (may be empty)
  ocr_conf    REAL,                        -- avg confidence 0-100
  text_density REAL,                       -- 0-1, computed by router
  route       TEXT NOT NULL,               -- 'text' | 'vision'
  tags        TEXT,                        -- json array, llm-classified
  thread_id   TEXT NOT NULL REFERENCES threads(id)
);

-- threads: a capture + its multi-turn conversation
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,            -- uuid v7
  created_at  INTEGER NOT NULL,
  title       TEXT,                        -- llm-generated, ≤60 chars
  pinned      INTEGER DEFAULT 0
);

-- turns: every user/assistant message in a thread
CREATE TABLE turns (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  model       TEXT                         -- model id that produced response
);

-- FTS5 virtual table over searchable text
CREATE VIRTUAL TABLE captures_fts USING fts5(
  ocr_text, tags, content='captures', content_rowid='rowid'
);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  content, content='turns', content_rowid='rowid'
);

-- sqlite-vss for semantic search (loaded as runtime extension)
CREATE VIRTUAL TABLE capture_vec USING vss0(
  embedding(384)                           -- BGE-small dim
);
-- mapping: capture_vec.rowid ↔ captures.rowid

-- Indices
CREATE INDEX idx_captures_created ON captures(created_at DESC);
CREATE INDEX idx_captures_thread  ON captures(thread_id);
CREATE INDEX idx_turns_thread     ON turns(thread_id, created_at);
```

### Privacy Promise

```
On disk (encrypted at rest by macOS FileVault if user has it on):
  ├── glint.db                  metadata + text + tags
  ├── captures/*.png            full screenshots
  ├── models/                   LLM weights (one-time download)
  └── logs/                     no OCR text, no PII

NEVER on disk:
  ├── audio                     no audio capture, ever
  ├── continuous screen         no always-on recording
  └── telemetry                 no analytics, no crash reports without prompt

NEVER over network:
  ├── after one-time model download, ZERO outbound
  ├── auto-update check         optional, OFF by default
  └── lint rule + runtime guard prevent accidental fetch() in core/
```

## Local Models

| Model | HF repo (mlx-community) | Size | Used for | Latency on M2 |
|-------|------------------------|------|----------|---------------|
| Qwen2.5-7B-Instruct (4-bit) | `mlx-community/Qwen2.5-7B-Instruct-4bit` | ~4 GB | Text-route answers, auto-tag, title gen | 1-3s first token |
| Qwen2-VL-7B-Instruct (4-bit) | `mlx-community/Qwen2-VL-7B-Instruct-4bit` | ~6 GB | Vision-route answers | 5-15s first token |
| BGE-small-en-v1.5 | `mlx-community/bge-small-en-v1.5-mlx` | ~30 MB | Embeddings for semantic search | <100ms per query |

**Model resolution at first run**: installer fetches by exact repo id above. If a repo is unreachable (Hugging Face down, network policy block), wizard surfaces the URL for manual download into `models/<id>/`. Versions are pinned in `package.json` under `glint.models` to avoid silent upgrade surprises.

**Runtime**: `mlx_lm.server` spawned as child process at app boot, listens on `localhost:8765`. OpenAI-compatible API. Models are kept resident in unified memory (~10GB total when both LLMs loaded).

**First-run wizard**: Downloads from Hugging Face Hub with progress UI. User can skip vision model for slimmer install (lose vision-route quality, OCR-route still works).

## Local Development Workflow

### The v1 pain (and what fixes it)

| v1 issue | Root cause | v2 fix |
|----------|------------|--------|
| Slow rebuild | `tsc` whole-project, no incremental | `electron-forge` + `@electron-forge/plugin-vite`. Vite handles TS in-memory. |
| Quit-restart per change | No HMR, no electron-reload | `vite-plugin-electron` watches main, auto-restarts. React Fast Refresh on renderer. |
| `npm i` breaks app | Native modules need `electron-rebuild` | Forge runs rebuild automatically post-install. |
| "Install to grant perms" loop | Each `electron-forge make` produces new binary path → macOS demands fresh Screen Recording perm | Dev mode runs unpacked `node_modules/.bin/electron` (stable path). Grant once, persists. |
| Can't unit-test core logic | `main.ts` mixed Electron APIs into business logic | Core has zero Electron imports (decision #2). Vitest runs `core/**` in plain node. |
| Have to load real model to test UI | OpenAI key was required to render anything | `GLINT_LLM=fake` env flag → returns fixture responses. UI iterable without weights. |

### Dev commands

```bash
npm run dev          # Vite + Electron in HMR mode (the daily driver)
npm run test         # Vitest, watch mode
npm run test:e2e     # Playwright on packaged Electron
npm run typecheck    # tsc --noEmit
npm run lint
npm run package      # Forge package (unsigned, for local testing)
npm run make         # Forge make DMG
```

### Dev modes via env flags

```bash
GLINT_LLM=fake npm run dev       # No model load — UI work
GLINT_LLM=real npm run dev       # Real MLX (default)
GLINT_OCR=fake npm run dev       # Stub OCR for capture pipeline tests
GLINT_DB=:memory: npm run dev    # In-memory SQLite, no persistence
```

## Error Handling

| Failure | Detection | Recovery | User-facing |
|---------|-----------|----------|-------------|
| Marquee cancel (Esc) | overlay key handler | close overlay, no DB write | silent |
| Screen Recording perm denied | `systemPreferences.getMediaAccessStatus` on capture attempt | open System Settings deep-link | modal: "grant access to capture" |
| MLX server crash | runtime heartbeat (HTTP `/health` every 30s) | spawn new server, retry once | toast: "model restarted, retrying…" |
| Model weights missing (1st run) | `runtime.ensureModels()` at boot | download w/ progress (Hugging Face) | first-run wizard, progress bar |
| OCR fails (tesseract throws) | try/catch in OCRSvc | fall through to vision path | invisible — graceful degrade |
| Disk full on save | `ENOSPC` errno in fs write | abort save, keep capture in mem | toast: "free up disk to save" |
| OOM on model load | spawn exit code | offer smaller model (Qwen2.5-3B) | modal: "close apps or use smaller model" |
| Embed fails (rare) | try/catch in EmbedSvc | save capture w/o vector, mark `embed_pending=1` | invisible — retried at boot |
| Network call attempted | static lint rule on core/ + runtime guard | block + log | dev-only assertion |

### First-run flow (critical UX)

```
launch app for first time
    │
    ▼
welcome screen
    │
    ▼
"Glint runs entirely on your Mac. Models download once (~10GB)."
    │
    ▼
[Continue]
    │
    ▼
request Screen Recording permission
    │
    ▼ user grants in System Settings
    ▼
download Qwen2.5-7B (4GB) — progress bar, cancellable
    │
    ▼
download Qwen2-VL-7B (6GB) — optional, can skip
    │
    ▼
download BGE-small (30MB) — required for search
    │
    ▼
"Ready. Press ⌘⇧X anytime to capture."
```

## Testing Strategy

Coverage target: **80%** across branches/functions/lines/statements (per global rules).

```
            ┌──────┐
            │ E2E  │   ~10 tests, Playwright on packaged Electron
            └──────┘
         ┌────────────┐
         │integration │   ~30 tests
         └────────────┘
      ┌──────────────────┐
      │      unit        │   ~150 tests, vitest on core/ pure TS
      └──────────────────┘
```

| Layer | Targets | Mocks | Tools |
|-------|---------|-------|-------|
| **Unit** (core/) | router density, HistoryStore CRUD, search ranking, ThreadMgr context, prompt loader, embed wrapper | none — pure TS | vitest |
| **Integration** | IPC contract, SQLite+vss against fixtures, MLX runtime lifecycle (spawn/health/kill), tesseract on real PNG fixtures | MLX → fake HTTP server returning fixtures | vitest + child_process |
| **E2E** | hotkey → capture → response (mocked LLM), search returns expected, continue thread, history filters, first-run wizard | LLM via mock server, ScreenCaptureKit via stub PNG | Playwright + electron-playwright-helpers |

### Manual smoke checks before each release

```
☐ first-run perm flow (Screen Recording prompt)
☐ first-run model download flow (cancellable, resumable)
☐ multi-display capture (v1 had bugs here)
☐ hotkey conflicts (Raycast, Bartender, etc.)
☐ app quit cleans MLX server (no orphan process via `pgrep mlx_lm.server`)
☐ history search at 1k / 10k captures (perf < 100ms)
☐ light + dark mode rendering
☐ external display + Retina scaling
☐ airplane mode after first-run completion (must work)
```

## Open Questions

1. **Model download UX**: bundle a lazy "skip vision model" option, or force both? Recommend: force text model, optional vision.
2. **MLX server port**: hardcode `8765` or pick free port at boot? Hardcoded is simpler; conflict risk is low (uncommon port). Use ephemeral port w/ fallback if 8765 taken.
3. **Auto-update**: ship with Squirrel.Mac auto-update (privacy concern: probes server on launch) or manual download from Releases page? Recommend: manual for v2.0, opt-in auto-update later.
4. **Telemetry**: zero telemetry is the privacy promise. Crash reports? Recommend: opt-in only, never on by default, fully local log files for self-debug.

## Glossary

| Term | Meaning |
|------|---------|
| MLX | Apple's ML framework for Apple Silicon. Native unified-memory inference. |
| FTS5 | SQLite full-text search v5. Built-in, fast, supports BM25. |
| sqlite-vss | SQLite extension for vector search via FAISS bindings. |
| BGE-small | Beijing Academy embedding model, 384-dim, ~30MB. State of art at this size. |
| Hybrid router | Decides text-LLM vs vision-LLM path based on OCR text density. |
| Sidecar process | Long-running child process the app talks to over localhost. |

## Acceptance Criteria

The build is shippable when:

1. ✅ Hotkey `⌘⇧X` captures any region of any monitor and produces an AI answer within 15s on M2 16GB.
2. ✅ All processing happens on-device. Network monitor confirms zero outbound after first-run.
3. ✅ History panel `⌘⇧H` opens in <100ms. Search returns in <100ms at 10k captures.
4. ✅ Continue thread restores full context. Agent answers as if conversation never ended.
5. ✅ Multi-turn chat reply works in response window. Each turn streams token-by-token.
6. ✅ App survives MLX crash, OCR crash, disk full. User sees actionable message in each case.
7. ✅ First-run wizard completes happy path on a fresh M-series Mac in <15 min including downloads.
8. ✅ Unit + integration + E2E suites pass with 80% coverage. CI runs in <5 min (mock LLM).
9. ✅ App quits cleanly. No orphan `mlx_lm.server` process, no zombie windows.
10. ✅ Manual smoke checklist passes on M1, M2, M3 with internal + external displays.
