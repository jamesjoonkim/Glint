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
        log.debug(
          { repo: spec.repo, stderr: c.toString().trim() },
          'downloader stderr',
        ),
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
