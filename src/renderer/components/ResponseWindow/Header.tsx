import styles from './styles.module.css';

type Status = 'warming' | 'streaming' | 'done' | 'error';

const LABEL: Record<Status, string> = {
  warming: 'reading',
  streaming: 'streaming',
  done: 'done',
  error: 'error',
};

export function Header({ status }: { status: Status }): JSX.Element {
  return (
    <header className={styles.header} data-status={status}>
      <div className={styles.trafficSpacer} aria-hidden />
      <div className={styles.brand}>
        <SparkGlyph />
        <span className={styles.brandWord}>Glint</span>
      </div>
      <div className={styles.statusPill} data-status={status}>
        <span className={styles.statusDot} />
        <span className={styles.statusLabel}>{LABEL[status]}</span>
      </div>
    </header>
  );
}

function SparkGlyph(): JSX.Element {
  return (
    <svg
      className={styles.spark}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M12 2 L13.6 8.6 L20 10 L13.6 11.4 L12 22 L10.4 11.4 L4 10 L10.4 8.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}
