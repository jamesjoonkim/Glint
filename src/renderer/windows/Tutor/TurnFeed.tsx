import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EventCard, type CardTurn } from './EventCard.js';
import styles from './styles.module.css';

interface Props {
  turns: CardTurn[];
}

const STICK_THRESHOLD_PX = 80;

function matchesQuery(t: CardTurn, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (t.userPrompt.toLowerCase().includes(needle)) return true;
  if (t.explanation.toLowerCase().includes(needle)) return true;
  for (const tool of t.tools) {
    if (tool.name.toLowerCase().includes(needle)) return true;
    const blob = JSON.stringify(tool.input).toLowerCase();
    if (blob.includes(needle)) return true;
  }
  for (const d of t.diffs) {
    if (d.file.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

export function TurnFeed({ turns }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const filtered = useMemo(
    () => turns.filter((t) => matchesQuery(t, query)),
    [turns, query],
  );

  // Track scroll position to know if user scrolled away from bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuckToBottom(dist <= STICK_THRESHOLD_PX);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll: only if user hasn't scrolled away from bottom.
  useLayoutEffect(() => {
    if (!stuckToBottom) return;
    if (selectedIdx !== null) return; // don't fight selection scroll
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    filtered.length,
    filtered[filtered.length - 1]?.explanation.length,
    stuckToBottom,
    selectedIdx,
  ]);

  // Keyboard nav: j/k cycle, / focuses search, esc clears selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingInInput()) {
        // Allow esc to clear search even while in input
        if (e.key === 'Escape' && searchInputRef.current === document.activeElement) {
          setQuery('');
          searchInputRef.current?.blur();
        }
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === 'j' || e.key === 'k') {
        if (filtered.length === 0) return;
        e.preventDefault();
        setSelectedIdx((curr) => {
          if (curr === null) return e.key === 'j' ? 0 : filtered.length - 1;
          if (e.key === 'j') return Math.min(filtered.length - 1, curr + 1);
          return Math.max(0, curr - 1);
        });
      }
      if (e.key === 'Escape' && selectedIdx !== null) {
        setSelectedIdx(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered.length, selectedIdx]);

  // Scroll selected card into view.
  useEffect(() => {
    if (selectedIdx === null) return;
    const t = filtered[selectedIdx];
    if (!t) return;
    const el = cardRefs.current.get(t.turnIdx);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedIdx, filtered]);

  if (turns.length === 0) {
    return (
      <div className={styles.feedEmpty}>
        Watching for new turns. Make Claude Code do something — Edit, Write, Bash —
        and it'll show up here.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={styles.feedScroll}>
      <div className={styles.feedToolbar}>
        <input
          ref={searchInputRef}
          type="search"
          className={styles.feedSearch}
          placeholder="filter by file, tool, or text…  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={styles.feedCounter}>
          {filtered.length}{filtered.length !== turns.length ? ` / ${turns.length}` : ''}
        </span>
      </div>

      {filtered.length === 0 && query && (
        <div className={styles.feedEmpty}>nothing matches "{query}"</div>
      )}

      <div className={styles.feed}>
        {filtered.map((t, i) => (
          <div
            key={t.turnIdx}
            ref={(el) => {
              if (el) cardRefs.current.set(t.turnIdx, el);
              else cardRefs.current.delete(t.turnIdx);
            }}
            className={i === selectedIdx ? styles.cardSelected : undefined}
          >
            <EventCard turn={t} />
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {!stuckToBottom && selectedIdx === null && (
        <button
          type="button"
          className={styles.feedJump}
          onClick={() => {
            setStuckToBottom(true);
            endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  );
}
