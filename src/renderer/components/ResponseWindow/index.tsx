import { useEffect, useRef, useState } from 'react';
import { Header } from './Header.js';
import { EmptyState } from './EmptyState.js';
import { ChatReply } from './ChatReply.js';
import { TurnList, type Turn, type ReplayCapture } from './TurnList.js';
import { useStream } from '../../hooks/useStream.js';
import styles from './styles.module.css';

function getStreamIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('streamId');
  // Sentinels (`replay-…` for history, `chat-…` for direct chat) are not
  // real stream ids — the renderer should not subscribe to token events.
  if (!id || id.startsWith('replay-') || id.startsWith('chat-')) return null;
  return id;
}

export function ResponseWindow(): JSX.Element {
  const initialStreamId = getStreamIdFromUrl();
  const [streamId, setStreamIdState] = useState<string | null>(initialStreamId);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [capture, setCapture] = useState<ReplayCapture | undefined>(undefined);
  const [webSearchQuery, setWebSearchQuery] = useState<string | null>(null);
  const stream = useStream(initialStreamId);
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * The stream-id ref inside useStream MUST be updated synchronously from
   * the response:set-stream IPC handler — otherwise tokens that fire on the
   * same renderer tick land before React commits the state change, and the
   * filter inside useStream's listeners drops them. setStreamId() does both:
   * mutates the ref AND schedules a React update so dependent UI re-renders.
   */
  const setStreamId = (id: string | null) => {
    stream.setStreamId(id);
    setStreamIdState(id);
  };

  const refreshTurns = (id: string) => {
    void (async () => {
      const res = (await window.glint?.invoke?.('thread:getTurns', { threadId: id })) as
        | { ok: boolean; turns?: Turn[] }
        | undefined;
      // Only overwrite when the DB actually has turns. An empty result is
      // almost always a race against the in-flight write — keep the last
      // good state rather than blanking the UI.
      if (res?.ok && Array.isArray(res.turns) && res.turns.length > 0) {
        setTurns(res.turns);
      }
    })();
  };

  const refreshCapture = (id: string) => {
    void (async () => {
      const res = (await window.glint?.invoke?.('thread:getCapture', { threadId: id })) as
        | { ok: boolean; capture?: { id: string; createdAt: number } }
        | undefined;
      if (res?.ok && res.capture) {
        setCapture({ id: res.capture.id, createdAt: res.capture.createdAt });
      }
    })();
  };

  useEffect(() => {
    const safeSubscribe = (channel: string, fn: (e: unknown, p: unknown) => void) => {
      try {
        return window.glint?.subscribe?.(channel, fn);
      } catch (err) {
        console.error(`subscribe failed for ${channel}:`, err);
        return undefined;
      }
    };
    const offStream = safeSubscribe('response:set-stream', (_e, p) => {
      const id = (p as { streamId?: unknown })?.streamId;
      // New stream id arrives both for fresh captures AND for follow-up
      // messages on the same thread. Don't touch turns/capture here — the
      // thread handler below decides whether the conversation actually
      // changed.
      if (typeof id === 'string') setStreamId(id);
    });
    const offThread = safeSubscribe('response:set-thread', (_e, p) => {
      const id = (p as { threadId?: unknown })?.threadId;
      if (typeof id !== 'string') return;
      setThreadId((prev) => {
        if (prev !== id) {
          // Thread actually changed → wipe stale state from a prior capture.
          setTurns([]);
          setCapture(undefined);
        }
        return id;
      });
      refreshCapture(id);
      // No refreshTurns for a fresh capture (turns don't exist yet); the
      // done-handler below loads them once the assistant turn is persisted.
    });
    const offReplay = safeSubscribe('response:replay', (_e, p) => {
      const id = (p as { threadId?: unknown })?.threadId;
      if (typeof id === 'string') {
        setStreamId(null);
        refreshTurns(id);
        refreshCapture(id);
      }
    });
    const offWebSearch = safeSubscribe('model:tool:web-search', (_e, p) => {
      const query = (p as { query?: unknown })?.query;
      if (typeof query === 'string') {
        setWebSearchQuery(query);
        // Clear after 4s if the next round of tokens hasn't already cleared.
        setTimeout(() => setWebSearchQuery((cur) => (cur === query ? null : cur)), 4000);
      }
    });
    return () => {
      offStream?.();
      offThread?.();
      offReplay?.();
      offWebSearch?.();
    };
  }, []);

  // When a stream completes, immediately materialize the streamed text as a
  // permanent assistant bubble — otherwise there's a visible gap between
  // when liveStreaming disappears (gated on !stream.done) and when the
  // refreshTurns IPC round-trip resolves. Then refresh from the DB to swap
  // the optimistic content for the canonical row (same text, real id+model).
  const lastDoneStreamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!stream.done || !streamId || !threadId) return;
    if (lastDoneStreamRef.current === streamId) return;
    lastDoneStreamRef.current = streamId;
    if (stream.text.trim()) {
      setTurns((prev) => [...prev, { role: 'assistant', content: stream.text }]);
    }
    refreshTurns(threadId);
  }, [stream.done, stream.text, streamId, threadId]);

  // Sticky-bottom auto-scroll: follow new tokens ONLY when the user is
  // already near the bottom. If they've scrolled up to read history, leave
  // them alone — yanking them back to the bottom on every token mid-read
  // is the worst chat-app feeling.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    // 80px threshold: forgiving enough that small over-scroll bounces don't
    // detach you from "follow mode," tight enough that scrolling up by even
    // one or two lines stops the auto-follow.
    if (distanceFromBottom < 80) {
      body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
    }
  }, [stream.text, turns.length]);

  const status = stream.error
    ? 'error'
    : streamId && !stream.done
      ? stream.text.length > 0
        ? 'streaming'
        : 'warming'
      : 'done';

  const handleReply = (text: string) => {
    if (!threadId) return;
    // Optimistic: show user bubble immediately.
    setTurns((prev) => [...prev, { role: 'user', content: text }]);
    void window.glint?.invoke?.('thread:appendTurn', { threadId, content: text });
  };

  const replyDisabled = !threadId || (streamId !== null && !stream.done);

  // While streaming AFTER the initial answer, the live tokens belong to a
  // new assistant turn that isn't in `turns` yet (we'll refetch on done).
  // For the initial capture's first stream, `turns` is empty; the streaming
  // bubble is the only thing on screen.
  const liveStreaming: { content: string; phase: 'warming' | 'streaming' } | undefined =
    streamId && !stream.done
      ? {
          content: stream.text,
          phase: stream.text.length > 0 ? 'streaming' : 'warming',
        }
      : undefined;

  return (
    <div className={styles.root}>
      <Header status={status} />
      {webSearchQuery && (
        <div className={styles.toolBanner} role="status" aria-live="polite">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3 12 H21 M12 3 C15 6 15 18 12 21 C9 18 9 6 12 3" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>searching the web · </span>
          <span className={styles.toolBannerQuery}>{webSearchQuery}</span>
        </div>
      )}
      <main className={styles.body} ref={bodyRef}>
        {stream.error ? (
          <ErrorView message={stream.error} />
        ) : turns.length === 0 && !liveStreaming && !capture ? (
          <EmptyState phase={streamId ? 'reading' : 'idle'} />
        ) : (
          <TurnList turns={turns} capture={capture} streaming={liveStreaming} />
        )}
      </main>
      <footer className={styles.footer}>
        <ChatReply
          disabled={replyDisabled}
          threadId={threadId}
          streaming={streamId !== null && !stream.done}
          onSend={handleReply}
          onCancel={() => {
            if (streamId) {
              void window.glint?.invoke?.('model:stream:cancel', { streamId });
            }
          }}
        />
      </footer>
    </div>
  );
}

function ErrorView({ message }: { message: string }): JSX.Element {
  return (
    <div className={styles.errorView}>
      <p className={styles.errorTitle}>Something went sideways.</p>
      <p className={styles.errorBody}>{message}</p>
    </div>
  );
}
