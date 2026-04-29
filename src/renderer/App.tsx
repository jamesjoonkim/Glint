import styles from './App.module.css';

export function App(): JSX.Element {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>Glint v2</span>
        <span className={styles.tag}>local-first · pre-alpha</span>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>Bootstrap OK</h1>
        <p className={styles.body}>
          P0 scaffold is live. Hotkey, capture, OCR, MLX runtime, and history land in P1+.
        </p>
        <code className={styles.code}>⌘⇧X · ⌘⇧H · ⌘,</code>
      </main>
    </div>
  );
}
