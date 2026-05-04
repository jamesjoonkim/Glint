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
  readonly role: ModelRole;
  readonly repo: string;
  readonly localDir: string;
  /** Approximate on-disk size after download, in gigabytes. UI hint only. */
  readonly sizeGB: number;
  /** Human-readable label for the wizard. */
  readonly label: string;
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

/** Sum of `sizeGB` across the manifest. Approximate, UI hint only. */
export const MANIFEST_TOTAL_GB: number = MODEL_MANIFEST.reduce(
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
