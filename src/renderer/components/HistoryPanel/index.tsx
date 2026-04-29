import { useState } from 'react';
import { useHistory, type HistoryItem } from '../../hooks/useHistory.js';
import styles from './styles.module.css';

function formatDate(ts: number): { day: string; time: string } {
  const d = new Date(ts);
  return {
    day: d.toLocaleString(undefined, { month: 'short', day: 'numeric' }),
    time: d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

function snippet(text: string | null, max: number = 140): string {
  if (!text || !text.trim()) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function CaptureCard({ item }: { item: HistoryItem }): JSX.Element {
  const { day, time } = formatDate(item.createdAt);
  const text = snippet(item.ocrText);
  // Render thumb if we have one; otherwise let OCR text become the visual.
  const thumbSrc = item.thumbPath
    ? `glint-asset://capture/${item.id}?kind=thumb`
    : null;
  const tag = item.tags[0];

  return (
    <button
      className={styles.card}
      aria-label={`Open capture from ${day} ${time}`}
      onClick={() =>
        window.glint?.invoke?.('history:open', { captureId: item.id }).catch(() => {})
      }
    >
      <div className={styles.thumbWrap}>
        {thumbSrc ? (
          <img className={styles.thumb} src={thumbSrc} alt="" loading="lazy" />
        ) : (
          <div className={styles.thumbFallback}>
            {text ? <p className={styles.fallbackText}>{snippet(text, 90)}</p> : (
              <p className={styles.fallbackEmpty}>untitled</p>
            )}
          </div>
        )}
        {tag && <span className={styles.tagBadge}>{tag}</span>}
      </div>
      <div className={styles.meta}>
        <div className={styles.dateRow}>
          <span className={styles.day}>{day}</span>
          <span className={styles.dot}>·</span>
          <span className={styles.time}>{time}</span>
        </div>
        {text ? (
          <p className={styles.snippet}>{text}</p>
        ) : (
          <p className={styles.snippetMuted}>no text recognized</p>
        )}
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
        <div className={styles.brandRow}>
          <h1 className={styles.brand}>Glint</h1>
          <span className={styles.subtitle}>
            screen captures · annotated and indexed
          </span>
        </div>
        <div className={styles.tools}>
          <input
            type="search"
            className={styles.search}
            placeholder="Search captures, OCR, tags…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(q);
            }}
            aria-label="Search captures"
          />
          <span className={styles.hint}>
            <kbd>⌘⇧X</kbd>
            <span>capture</span>
          </span>
        </div>
      </header>
      <main className={styles.body}>
        {error && <div className={styles.error}>error · {error}</div>}
        {loading && !error && <div className={styles.loading}>loading the archive…</div>}
        {!loading && items.length === 0 && !error && (
          <div className={styles.empty}>
            <h2 className={styles.emptyTitle}>The archive is empty.</h2>
            <p className={styles.emptyBody}>
              Press <kbd>⌘⇧X</kbd> to draw a region anywhere on your Mac.
              Glint reads what's there, answers it, and binds the thread to
              this page.
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
