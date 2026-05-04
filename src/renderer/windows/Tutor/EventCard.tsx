import { DiffView } from './DiffView.js';
import styles from './styles.module.css';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
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

export function EventCard({ turn }: { turn: CardTurn }): JSX.Element | null {
  // Hide cards Qwen explicitly skipped — keeps the feed signal-dense.
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
            <span key={i} className={styles.cardTool}>
              <span className={styles.cardToolName}>{t.name}</span>
              <span className={styles.cardToolInput}>{briefInput(t)}</span>
            </span>
          ))}
        </div>
      )}

      {turn.diffs.map((d, i) => (
        <DiffView key={i} file={d.file} oldText={d.old} newText={d.new} />
      ))}

      {!turn.historical && (
        <div className={styles.cardExplain}>
          {turn.explanation ? (
            <pre className={styles.cardExplainText}>{turn.explanation}</pre>
          ) : (
            <span className={styles.cardExplainPending}>thinking…</span>
          )}
          {!turn.explanationDone && turn.explanation && (
            <span className={styles.cardExplainCursor}>▋</span>
          )}
        </div>
      )}
    </article>
  );
}
