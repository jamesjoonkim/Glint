import styles from './styles.module.css';

export function EmptyState({ phase }: { phase: 'reading' | 'thinking' }): JSX.Element {
  return (
    <div className={styles.empty} role="status" aria-live="polite">
      <div className={styles.scanFrame}>
        <span className={`${styles.corner} ${styles.cornerTL}`} />
        <span className={`${styles.corner} ${styles.cornerTR}`} />
        <span className={`${styles.corner} ${styles.cornerBL}`} />
        <span className={`${styles.corner} ${styles.cornerBR}`} />
        <span className={styles.scanBeam} />
      </div>
      <p className={styles.emptyLabel}>
        {phase === 'reading' ? 'reading the capture' : 'thinking'}
      </p>
      <p className={styles.emptyHint}>
        Local model. No data leaves your Mac.
      </p>
    </div>
  );
}
