import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EventCard, type CardTurn } from './EventCard.js';
import styles from './styles.module.css';

interface Props {
  turns: CardTurn[];
}

const STICK_THRESHOLD_PX = 80;

export function TurnFeed({ turns }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  /**
   * "Stuck to bottom" mode. True initially. Set to false the moment the
   * user scrolls up by more than STICK_THRESHOLD_PX. Set back to true if
   * they scroll back to the bottom themselves. Auto-scroll only fires
   * while this is true — never overrides a manual scroll-up.
   */
  const [stuckToBottom, setStuckToBottom] = useState(true);

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
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    turns.length,
    turns[turns.length - 1]?.explanation.length,
    stuckToBottom,
  ]);

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
      <div className={styles.feed}>
        {turns.map((t) => (
          <EventCard key={t.turnIdx} turn={t} />
        ))}
        <div ref={endRef} />
      </div>
      {!stuckToBottom && (
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
