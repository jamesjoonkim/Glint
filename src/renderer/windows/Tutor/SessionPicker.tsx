import { useCallback, useEffect, useState } from 'react';
import styles from './styles.module.css';

interface Session {
  jsonlPath: string;
  cwd: string;
  primary: string;
  secondary?: string;
  sessionUuid: string;
  mtimeMs: number;
  sizeBytes: number;
  active: boolean;
}

interface Props {
  onPick: (s: Session) => void;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

export function SessionPicker({ onPick }: Props): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!window.glint) return;
    setLoading(true);
    try {
      const result = (await window.glint.invoke('tutor:list-sessions')) as Session[];
      setSessions(result);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <p className={styles.title}>Lens</p>
        <h1 className={styles.heading}>Sessions</h1>
        <p className={styles.subhead}>
          Pick a session to follow. Active = modified in the last 30 minutes.
        </p>
      </header>

      <div className={styles.body}>
        {loading && <div className={styles.empty}>scanning…</div>}

        {!loading && sessions.length === 0 && (
          <div className={styles.empty}>
            No Claude Code sessions found in <code>~/.claude/projects/</code>.
          </div>
        )}

        {!loading &&
          sessions.map((s) => (
            <button
              key={s.jsonlPath}
              type="button"
              className={styles.row}
              onClick={() => onPick(s)}
            >
              <span
                className={`${styles.dot} ${s.active ? styles.dotActive : styles.dotStale}`}
                aria-hidden
              />
              <div className={styles.rowMain}>
                <div className={styles.rowName}>
                  <span className={styles.rowPrimary}>
                    {s.primary || s.cwd.split('/').filter(Boolean).pop() || '?'}
                  </span>
                  {s.secondary && (
                    <span className={styles.rowSecondary}>· {s.secondary}</span>
                  )}
                </div>
                <div className={styles.rowMeta}>
                  {relativeTime(s.mtimeMs)} · {kb(s.sizeBytes)} · {s.sessionUuid.slice(0, 8)}
                </div>
              </div>
            </button>
          ))}

        {!loading && (
          <button type="button" className={styles.refreshBtn} onClick={refresh}>
            refresh
          </button>
        )}
      </div>
    </div>
  );
}
