import { useEffect, useState } from 'react';
import { MarkdownView } from './MarkdownView.js';
import { Header } from './Header.js';
import { EmptyState } from './EmptyState.js';
import { ChatReply } from './ChatReply.js';
import { useStream } from '../../hooks/useStream.js';
import styles from './styles.module.css';

type Turn = { role: 'user' | 'assistant' | 'system'; content: string };

function getStreamIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('streamId');
  // Replay sentinels start with 'replay-' — main passes them so the response
  // window can mount, but they aren't real stream ids. Treat as null.
  if (!id || id.startsWith('replay-')) return null;
  return id;
}

export function ResponseWindow(): JSX.Element {
  const [streamId, setStreamId] = useState<string | null>(getStreamIdFromUrl());
  const [threadId, setThreadId] = useState<string | null>(null);
  const [replayText, setReplayText] = useState<string | null>(null);
  const stream = useStream(streamId);

  useEffect(() => {
    const safeSubscribe = (channel: string, fn: (e: unknown, p: unknown) => void) => {
      try {
        return window.glint?.subscribe?.(channel, fn);
      } catch (err) {
        console.error(`subscribe failed for ${channel}:`, err);
        return undefined;
      }
    };
    const offStream = safeSubscribe(
      'response:set-stream',
      (_e: unknown, payload: unknown) => {
        const id = (payload as { streamId?: unknown })?.streamId;
        if (typeof id === 'string') {
          // Live stream supersedes replay content.
          setReplayText(null);
          setStreamId(id);
        }
      },
    );
    const offThread = safeSubscribe(
      'response:set-thread',
      (_e: unknown, payload: unknown) => {
        const id = (payload as { threadId?: unknown })?.threadId;
        if (typeof id === 'string') setThreadId(id);
      },
    );
    const offReplay = safeSubscribe(
      'response:replay',
      (_e: unknown, payload: unknown) => {
        const id = (payload as { threadId?: unknown })?.threadId;
        if (typeof id !== 'string') return;
        void (async () => {
          const res = (await window.glint?.invoke?.('thread:getTurns', { threadId: id })) as
            | { ok: boolean; turns?: Turn[] }
            | undefined;
          if (!res?.ok || !Array.isArray(res.turns)) return;
          // Show the last assistant turn (initial answer + any follow-ups
          // collapse to the most recent reply for now — TurnList view is P4.1).
          const lastAssistant = [...res.turns].reverse().find((t) => t.role === 'assistant');
          setReplayText(lastAssistant?.content ?? '');
          setStreamId(null);
        })();
      },
    );
    return () => {
      offStream?.();
      offThread?.();
      offReplay?.();
    };
  }, []);

  const isReplay = replayText !== null;
  const displayText = isReplay ? replayText : stream.text;
  const status = isReplay
    ? 'done'
    : stream.error
      ? 'error'
      : stream.done
        ? 'done'
        : stream.text.length > 0
          ? 'streaming'
          : 'warming';

  const handleReply = (text: string) => {
    if (!threadId) return;
    void window.glint?.invoke?.('thread:appendTurn', { threadId, content: text });
  };

  const replyDisabled = !threadId || (!isReplay && !stream.done);

  return (
    <div className={styles.root}>
      <Header status={status} />
      <main className={styles.body}>
        {stream.error && !isReplay ? (
          <ErrorView message={stream.error} />
        ) : !displayText ? (
          <EmptyState phase={status === 'streaming' ? 'thinking' : 'reading'} />
        ) : (
          <MarkdownView source={displayText} />
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
