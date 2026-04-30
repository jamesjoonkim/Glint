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

function api() {
  if (!window.glint) throw new Error('glint preload not initialized');
  return window.glint;
}

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
    void api()
      .invoke(IPC.firstRun.getStatus)
      .then((s) => setStatus(s as Status));
    const off = api().subscribe('firstRun:progress', (_e, payload) => {
      const { repo, ev } = payload as { repo: string; ev: ProgressEvent };
      setRows((prev) => ({ ...prev, [repo]: reduceRow(prev[repo], ev) }));
    });
    const offDone = api().subscribe('firstRun:done', () => setView('done'));
    const offErr = api().subscribe('firstRun:error', (_e, payload) => {
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
    void api().invoke(IPC.firstRun.start);
  };

  const retry = (repo: string): void => {
    setRows((prev) => ({ ...prev, [repo]: { kind: 'idle' } }));
    void api().invoke(IPC.firstRun.retry, repo);
  };

  const finish = (): void => {
    void api().invoke(IPC.firstRun.complete);
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
          <Row key={m.repo} spec={m} state={rows[m.repo] ?? { kind: 'idle' }} onRetry={() => retry(m.repo)} />
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
              // Inline width is the documented exception for dynamic values
              // computed from runtime data — see CLAUDE.md / coding-style.md.
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
