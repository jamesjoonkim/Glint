# Glint

Local-first AI screenshot assistant for Apple Silicon Macs. Press `⌘⇧X`, drag to select any region, get an explanation. All processing happens on your Mac. After a one-time model download, no data leaves your machine — no telemetry, no auto-update probes, no cloud LLM calls.

> **Status: v2 in active rebuild on `feature/v2-rebuild`.** v1 (cloud GPT-4V) is preserved at the `v1-final` tag.

## Features

- `⌘⇧X` — capture any region of any monitor → AI explanation streams to a floating window
- `⌘⇧H` — searchable history of every capture (semantic + keyword search)
- `⌘,` — settings
- Multi-turn chat in the response window — refine the answer or ask follow-ups
- Hybrid OCR routing: tesseract.js first, then text-LLM (Qwen2.5-7B) for text-heavy captures or vision-LLM (Qwen2-VL-7B) for everything else
- Auto-tags each capture (`code`, `error`, `article`, `ui`, `diagram`, …)
- LLM-generated thread titles for fast scanning of history

## Privacy

The privacy promise is enforced at lint time, not just claimed:

- `src/core/**` cannot import `electron`, `axios`, `node-fetch`, or call `fetch` (custom ESLint rule). Only `core/models/` and `core/embed/` are exempt — they talk exclusively to `127.0.0.1` and never the LAN.
- The bundled MLX runtime (`mlx_lm.server`) is launched with `--host 127.0.0.1`. Localhost-only binding is verified by an integration test that attempts a `0.0.0.0` connect and asserts refusal.
- The logger redacts OCR text, file paths, and tags before any line reaches disk.
- Auto-update is omitted in v2.0. Manual download from Releases.
- No telemetry. No crash reporting unless explicitly opted in (off by default).

## Installation

> v2 is pre-alpha. v1 DMGs/EXEs remain on the [Releases page](https://github.com/JamaJKIM/Glint/releases).

For v2, build from source until the first signed DMG ships:

```bash
git clone https://github.com/JamaJKIM/Glint.git
cd Glint
git checkout feature/v2-rebuild
nvm use         # Node 20
npm install
npm run dev
```

For real LLM inference, you'll need the bundled runtime. To build it locally (requires Apple Silicon + Python 3.11):

```bash
bash build/python/build-runtime.sh
```

Or run the dev loop with `GLINT_LLM=fake` for UI work without weights:

```bash
GLINT_LLM=fake npm run dev
```

## System Requirements

- macOS 13.0 or later
- Apple Silicon (M1, M2, M3, …) — required for MLX runtime
- 16 GB RAM recommended (vision model is ~6 GB resident)
- ~12 GB free disk after first run (LLM weights + history database)

## Architecture

Three layers, separated by import boundary:

| Layer | Responsibility | Imports |
|-------|----------------|---------|
| `src/main/` | Electron orchestration: lifecycle, windows, hotkeys, IPC | Electron + Node |
| `src/core/` | Pure logic: OCR, router, model client, history store, threads | Node only — **no Electron** |
| `src/renderer/` | React UI: SelectionOverlay, ResponseWindow, HistoryPanel, FirstRun, Settings | DOM only |

The split exists so `core/` can be unit-tested in plain Node and so the privacy contract can be lint-enforced.

See [`docs/superpowers/specs/2026-04-28-glint-v2-design.md`](docs/superpowers/specs/2026-04-28-glint-v2-design.md) for the design and [`docs/plans/glint-v2-plan.md`](docs/plans/glint-v2-plan.md) for the day-by-day implementation plan. Open [`docs/plans/glint-v2-interactive-plan.html`](docs/plans/glint-v2-interactive-plan.html) for a visual walkthrough.

## Development

```bash
npm run dev          # Vite + Electron with HMR
npm test             # Vitest unit + integration
npm run test:watch
npm run test:coverage
npm run test:e2e     # Playwright on packaged Electron
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (incl. core/ network ban)
npm run package      # Forge package (unsigned)
npm run make         # Forge make DMG
```

### Dev mode env flags

| Flag | Effect |
|------|--------|
| `GLINT_LLM=fake` | Replaces the model client with a deterministic fixture stream — no MLX runtime needed |
| `GLINT_OCR=fake` | Stubs OCR for capture-pipeline tests |
| `GLINT_DEBUG=1`  | Verbose `pino` logging |

## License

MIT — see [LICENSE](LICENSE).

## Credits

- Mixture of weights from the [`mlx-community`](https://huggingface.co/mlx-community) collection on Hugging Face
- OCR via [tesseract.js](https://github.com/naptha/tesseract.js)
- Markdown rendering via [react-markdown](https://github.com/remarkjs/react-markdown) + [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize)
- Local sqlite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
