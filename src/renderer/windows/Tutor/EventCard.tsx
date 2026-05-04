import { useState } from 'react';
import { DiffView } from './DiffView.js';
import styles from './styles.module.css';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  id?: string;
  result?: string | null;
  resultError?: boolean;
}

interface DiffBlock {
  file: string;
  old: string;
  new: string;
}

export interface CardTurn {
  turnIdx: number;
  timestamp: string;
  userPrompt: string;
  reasoning: string;
  tools: ToolUse[];
  diffs: DiffBlock[];
  explanation: string;
  explanationDone: boolean;
  historical?: boolean;
}

function briefInput(t: ToolUse): string {
  const input = t.input;
  const sval = (k: string): string =>
    typeof input[k] === 'string' ? (input[k] as string) : '';
  if (t.name === 'Bash') return sval('command').slice(0, 60);
  if (
    t.name === 'Edit' ||
    t.name === 'Write' ||
    t.name === 'MultiEdit' ||
    t.name === 'Read' ||
    t.name === 'NotebookEdit'
  ) {
    const fp = sval('file_path');
    return fp ? fp.split('/').pop() ?? '?' : '?';
  }
  if (t.name === 'Grep') return `'${sval('pattern').slice(0, 30)}'`;
  if (t.name === 'Glob') return sval('pattern').slice(0, 40);
  return '';
}

function formatTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function isSkip(s: string): boolean {
  return s.trim().toUpperCase() === 'SKIP';
}

function ExplainPane({ text, done }: { text: string; done: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const canCopy = done && text.trim().length > 0;
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard denied — silent
    }
  };
  return (
    <div className={styles.cardExplain}>
      {text ? (
        <pre className={styles.cardExplainText}>{text}</pre>
      ) : (
        <span className={styles.cardExplainPending}>thinking…</span>
      )}
      {!done && text && <span className={styles.cardExplainCursor}>▋</span>}
      {canCopy && (
        <button
          type="button"
          className={styles.copyBtn}
          onClick={onCopy}
          aria-label="copy explanation"
        >
          {copied ? '✓' : '⎘'}
        </button>
      )}
    </div>
  );
}

function ToolRow({ t, i }: { t: ToolUse; i: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasResult = typeof t.result === 'string' && t.result.length > 0;

  return (
    <div className={styles.toolRow}>
      <button
        type="button"
        className={`${styles.cardTool} ${hasResult ? styles.cardToolClickable : ''} ${
          t.resultError ? styles.cardToolError : ''
        }`}
        onClick={() => hasResult && setOpen((v) => !v)}
        disabled={!hasResult}
        aria-label={hasResult ? `toggle result for ${t.name}` : t.name}
      >
        <span className={styles.cardToolName}>{t.name}</span>
        <span className={styles.cardToolInput}>{briefInput(t)}</span>
        {hasResult && (
          <span className={styles.cardToolChevron}>{open ? '▾' : '▸'}</span>
        )}
        {t.resultError && <span className={styles.cardToolErrIcon}>!</span>}
      </button>
      {open && hasResult && (
        <pre className={styles.cardToolResult}>{t.result}</pre>
      )}
    </div>
  );
}

export function EventCard({ turn }: { turn: CardTurn }): JSX.Element | null {
  if (turn.explanationDone && isSkip(turn.explanation) && !turn.historical) {
    return null;
  }

  const cardClass = turn.historical
    ? `${styles.card} ${styles.cardHistorical}`
    : styles.card;
  return (
    <article className={cardClass}>
      <header className={styles.cardHeader}>
        <span className={styles.cardIdx}>
          Turn {turn.turnIdx}
          {turn.historical && <span className={styles.cardHistMark}> · history</span>}
        </span>
        <span className={styles.cardTime}>{formatTime(turn.timestamp)}</span>
      </header>

      {turn.tools.length > 0 && (
        <div className={styles.cardTools}>
          {turn.tools.map((t, i) => (
            <ToolRow key={t.id ?? i} t={t} i={i} />
          ))}
        </div>
      )}

      {turn.diffs.map((d, i) => (
        <DiffView key={i} file={d.file} oldText={d.old} newText={d.new} />
      ))}

      {!turn.historical && (
        <ExplainPane
          text={turn.explanation}
          done={turn.explanationDone}
        />
      )}
    </article>
  );
}
