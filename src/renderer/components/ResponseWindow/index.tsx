import { useEffect, useState } from 'react';
import { MarkdownView } from './MarkdownView.js';
import { useStream } from '../../hooks/useStream.js';
import styles from './styles.module.css';

function getStreamIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('streamId');
}

export function ResponseWindow(): JSX.Element {
  const [streamId, setStreamId] = useState<string | null>(getStreamIdFromUrl());
  const stream = useStream(streamId);

  useEffect(() => {
    const off = window.glint?.subscribe?.(
      'response:set-stream',
      (_e: unknown, payload: unknown) => {
        if (
          typeof payload === 'object' &&
          payload !== null &&
          'streamId' in payload &&
          typeof (payload as { streamId: unknown }).streamId === 'string'
        ) {
          setStreamId((payload as { streamId: string }).streamId);
        }
      },
    );
    return () => off?.();
  }, []);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <span className={styles.brand}>Glint</span>
        <div className={styles.status}>
          {stream.error ? (
            <span className={styles.error}>error: {stream.error}</span>
          ) : stream.done ? (
            <span className={styles.done}>done</span>
          ) : (
            <span className={styles.live}>streaming…</span>
          )}
        </div>
      </header>
      <main className={styles.body}>
        {stream.text ? (
          <MarkdownView source={stream.text} />
        ) : (
          <div className={styles.placeholder}>warming up the local model…</div>
        )}
      </main>
      <footer className={styles.footer}>
        <input
          className={styles.reply}
          placeholder="Reply (multi-turn lands in P4)…"
          disabled
          aria-disabled
        />
      </footer>
    </div>
  );
}
