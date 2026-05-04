import styles from './styles.module.css';

interface Props {
  file: string;
  oldText: string;
  newText: string;
}

const MAX_LINES = 80;

function clip(text: string, max: number): string[] {
  const lines = text.split('\n');
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… (${lines.length - max} more lines)`];
}

export function DiffView({ file, oldText, newText }: Props): JSX.Element {
  const oldLines = oldText ? clip(oldText, MAX_LINES) : [];
  const newLines = clip(newText, MAX_LINES);

  return (
    <div className={styles.diffBlock}>
      <div className={styles.diffFile}>{file}</div>
      <pre className={styles.diffPre}>
        {oldLines.map((ln, i) => (
          <div key={`o${i}`} className={styles.diffOld}>
            <span className={styles.diffMark}>-</span>
            <span className={styles.diffText}>{ln || ' '}</span>
          </div>
        ))}
        {newLines.map((ln, i) => (
          <div key={`n${i}`} className={styles.diffNew}>
            <span className={styles.diffMark}>+</span>
            <span className={styles.diffText}>{ln || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
