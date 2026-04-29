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
    return () => {
      offStream?.();
      offThread?.();
      offReplay?.();
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

  // Auto-scroll to bottom on new tokens.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
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
        <ChatReply disabled={replyDisabled} onSend={handleReply} />
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
