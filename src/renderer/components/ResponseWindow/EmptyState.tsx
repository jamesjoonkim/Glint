import styles from './styles.module.css';

type Phase = 'reading' | 'thinking' | 'idle';

const LABEL: Record<Phase, string> = {
  reading: 'reading the capture',
  thinking: 'thinking',
  idle: 'ask anything',
};

export function EmptyState({ phase }: { phase: Phase }): JSX.Element {
  return (
    <div className={styles.empty} role="status" aria-live="polite">
      <div className={styles.scanFrame}>
        <span className={`${styles.corner} ${styles.cornerTL}`} />
        <span className={`${styles.corner} ${styles.cornerTR}`} />
        <span className={`${styles.corner} ${styles.cornerBL}`} />
        <span className={`${styles.corner} ${styles.cornerBR}`} />
        {phase !== 'idle' && <span className={styles.scanBeam} />}
      </div>
      <p className={styles.emptyLabel}>{LABEL[phase]}</p>
      <p className={styles.emptyHint}>
        Local model. No data leaves your Mac.
      </p>
    </div>
  );
}
