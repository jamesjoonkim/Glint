import { MarkdownView } from './MarkdownView.js';
import styles from './styles.module.css';

export type Turn = { role: 'user' | 'assistant' | 'system'; content: string };

export type ReplayCapture = {
  id: string;
  createdAt: number;
};

type Props = {
  turns: Turn[];
  capture?: ReplayCapture;
  streaming?: { content: string; phase: 'warming' | 'streaming' };
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function TurnList({ turns, capture, streaming }: Props): JSX.Element {
  const visible = turns.filter((t) => t.role === 'user' || t.role === 'assistant');
  // "Reading the capture…" only makes sense when the model is processing the
  // initial screenshot. Any follow-up message (turns already exist) just says
  // "thinking…".
  const isFollowUp = visible.length > 0;
  const warmingLabel = isFollowUp ? 'thinking…' : 'reading the capture…';
  return (
    <div className={styles.turnList}>
      {capture && <CaptureBubble capture={capture} />}
      {visible.map((t, i) => (
        <Bubble key={i} role={t.role === 'user' ? 'user' : 'assistant'}>
          <MarkdownView source={t.content} />
        </Bubble>
      ))}
      {streaming && (
        <Bubble role="assistant" pending>
          {streaming.content ? (
            <MarkdownView source={streaming.content} isStreaming />
          ) : (
            <span className={styles.warming}>{warmingLabel}</span>
          )}
        </Bubble>
      )}
    </div>
  );
}

function CaptureBubble({ capture }: { capture: ReplayCapture }): JSX.Element {
  const src = `glint-asset://capture/${capture.id}?kind=full`;
  return (
    <div
      className={`${styles.bubble} ${styles.bubbleUser} ${styles.bubbleCapture}`}
      data-role="capture"
    >
      <img className={styles.captureImage} src={src} alt="captured region" />
      <div className={styles.captureMeta}>
        <span>captured</span>
        <span>{formatTimestamp(capture.createdAt)}</span>
      </div>
    </div>
  );
}

function Bubble({
  role,
  children,
  pending,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
  pending?: boolean;
}): JSX.Element {
  return (
    <div
      className={`${styles.bubble} ${
        role === 'user' ? styles.bubbleUser : styles.bubbleAssistant
      } ${pending ? styles.bubblePending : ''}`}
      data-role={role}
    >
      {children}
    </div>
  );
}
