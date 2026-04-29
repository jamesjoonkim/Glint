import { useState } from 'react';
import { useHistory, type HistoryItem } from '../../hooks/useHistory.js';
import styles from './styles.module.css';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function snippet(text: string | null, max: number = 80): string {
  if (!text) return '(no OCR text)';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function CaptureCard({ item }: { item: HistoryItem }): JSX.Element {
  const tagList = item.tags.slice(0, 3);
  return (
    <button
      className={styles.card}
      aria-label={`Capture ${formatTime(item.createdAt)}: ${snippet(item.ocrText, 120)}`}
      onClick={() =>
        window.glint?.invoke?.('history:open', { captureId: item.id }).catch(() => {})
      }
    >
      <div className={styles.thumbWrap}>
        {item.thumbPath ? (
          <img className={styles.thumb} src={`file://${item.thumbPath}`} alt="" />
        ) : (
          <div className={styles.thumbPlaceholder}>no preview</div>
        )}
      </div>
      <div className={styles.meta}>
        <div className={styles.metaTop}>
          <span className={styles.time}>{formatTime(item.createdAt)}</span>
          <div className={styles.tags}>
            {tagList.map((t) => (
              <span key={t} className={styles.tag}>
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className={styles.snippet}>{snippet(item.ocrText)}</div>
      </div>
    </button>
  );
}

export function HistoryPanel(): JSX.Element {
  const { items, loading, error, load } = useHistory();
  const [q, setQ] = useState('');

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <span className={styles.brand}>Glint</span>
        <input
          type="search"
          className={styles.search}
          placeholder="Search captures, OCR text, tags…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(q);
          }}
          aria-label="Search captures"
        />
        <span className={styles.hint}>
          <kbd>⌘⇧X</kbd> to capture
        </span>
      </header>
      <main className={styles.body}>
        {error && <div className={styles.error}>error: {error}</div>}
        {loading && !error && <div className={styles.loading}>loading…</div>}
        {!loading && items.length === 0 && !error && (
          <div className={styles.empty}>
            <h2>No captures yet</h2>
            <p>
              Press <kbd>⌘⇧X</kbd> anywhere on your Mac to grab a region — Glint reads it,
              answers it, and saves the thread here.
            </p>
          </div>
        )}
        <div className={styles.grid}>
          {items.map((item) => (
            <CaptureCard key={item.id} item={item} />
          ))}
        </div>
      </main>
    </div>
  );
}
