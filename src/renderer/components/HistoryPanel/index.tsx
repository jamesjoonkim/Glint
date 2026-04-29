import { useState } from 'react';
import { useHistory, type HistoryItem } from '../../hooks/useHistory.js';
import { useChatThreads, type ChatThreadItem } from '../../hooks/useChatThreads.js';
import styles from './styles.module.css';

type Tab = 'captures' | 'chats';

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
            {text ? (
              <p className={styles.fallbackText}>{snippet(text, 90)}</p>
            ) : (
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

function ChatCard({ item }: { item: ChatThreadItem }): JSX.Element {
  const tsForDisplay = item.lastTurnAt ?? item.createdAt;
  const { day, time } = formatDate(tsForDisplay);
  const preview = snippet(item.preview, 180) || 'untitled chat';
  const headline = item.title ?? snippet(item.preview, 60) ?? 'untitled chat';

  return (
    <button
      className={`${styles.card} ${styles.chatCard}`}
      aria-label={`Open chat from ${day} ${time}`}
      onClick={() =>
        window.glint?.invoke?.('history:openThread', { threadId: item.id }).catch(() => {})
      }
    >
      <div className={styles.chatBody}>
        <span className={styles.chatBadge}>chat</span>
        <h3 className={styles.chatTitle}>{headline}</h3>
        <p className={styles.chatPreview}>{preview}</p>
      </div>
      <div className={styles.meta}>
        <div className={styles.dateRow}>
          <span className={styles.day}>{day}</span>
          <span className={styles.dot}>·</span>
          <span className={styles.time}>{time}</span>
          <span className={styles.dot}>·</span>
          <span className={styles.time}>
            {item.turnCount} {item.turnCount === 1 ? 'turn' : 'turns'}
          </span>
        </div>
      </div>
    </button>
  );
}

export function HistoryPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('captures');
  const captures = useHistory();
  const chats = useChatThreads();
  const [q, setQ] = useState('');

  const showingCaptures = tab === 'captures';
  const loading = showingCaptures ? captures.loading : chats.loading;
  const error = showingCaptures ? captures.error : chats.error;

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
            placeholder={
              showingCaptures
                ? 'Search captures, OCR, tags…'
                : 'Search chats by title or message…'
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (showingCaptures) void captures.load(q);
              else void chats.load(q);
            }}
            aria-label="Search"
          />
          <span className={styles.hint}>
            <kbd>⌘⇧X</kbd>
            <span>capture</span>
          </span>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="archive sections">
        <button
          type="button"
          className={`${styles.tab} ${showingCaptures ? styles.tabActive : ''}`}
          onClick={() => setTab('captures')}
        >
          Captures
          <span className={styles.tabCount}>{captures.items.length}</span>
        </button>
        <button
          type="button"
          className={`${styles.tab} ${!showingCaptures ? styles.tabActive : ''}`}
          onClick={() => setTab('chats')}
        >
          Chats
          <span className={styles.tabCount}>{chats.items.length}</span>
        </button>
      </nav>

      <main className={styles.body}>
        {error && <div className={styles.error}>error · {error}</div>}
        {loading && !error && <div className={styles.loading}>loading the archive…</div>}

        {showingCaptures ? (
          <>
            {!loading && captures.items.length === 0 && !error && (
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
              {captures.items.map((item) => (
                <CaptureCard key={item.id} item={item} />
              ))}
            </div>
          </>
        ) : (
          <>
            {!loading && chats.items.length === 0 && !error && (
              <div className={styles.empty}>
                <h2 className={styles.emptyTitle}>No chats yet.</h2>
                <p className={styles.emptyBody}>
                  Press <kbd>⌘⇧Z</kbd> to open a direct chat with the local
                  model — no screenshot needed.
                </p>
              </div>
            )}
            <div className={styles.chatList}>
              {chats.items.map((item) => (
                <ChatCard key={item.id} item={item} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
