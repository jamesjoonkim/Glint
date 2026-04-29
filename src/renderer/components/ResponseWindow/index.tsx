import { useEffect, useState } from 'react';
import { MarkdownView } from './MarkdownView.js';
import { Header } from './Header.js';
import { EmptyState } from './EmptyState.js';
import { ChatReply } from './ChatReply.js';
import { useStream } from '../../hooks/useStream.js';
import styles from './styles.module.css';

function getStreamIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('streamId');
}

export function ResponseWindow(): JSX.Element {
  const [streamId, setStreamId] = useState<string | null>(getStreamIdFromUrl());
  const [threadId, setThreadId] = useState<string | null>(null);
  const stream = useStream(streamId);

  useEffect(() => {
    // Wrap subscribe calls so a single allowlist mismatch (or any throw)
    // doesn't abort the whole effect — that would leave React without
    // cleanup and the response window in a half-mounted state.
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
        if (typeof id === 'string') setStreamId(id);
      },
    );
    const offThread = safeSubscribe(
      'response:set-thread',
      (_e: unknown, payload: unknown) => {
        const id = (payload as { threadId?: unknown })?.threadId;
        if (typeof id === 'string') setThreadId(id);
      },
    );
    return () => {
      offStream?.();
      offThread?.();
    };
  }, []);

  const status = stream.error
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

  return (
    <div className={styles.root}>
      <Header status={status} />
      <main className={styles.body}>
        {stream.error ? (
          <ErrorView message={stream.error} />
        ) : stream.text.length === 0 ? (
          <EmptyState phase={status === 'streaming' ? 'thinking' : 'reading'} />
        ) : (
          <MarkdownView source={stream.text} />
        )}
      </main>
      <footer className={styles.footer}>
        <ChatReply disabled={!stream.done || !threadId} onSend={handleReply} />
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
