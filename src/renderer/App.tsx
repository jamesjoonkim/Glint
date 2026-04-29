import styles from './App.module.css';
import { SelectionOverlay } from './components/SelectionOverlay/index.js';
import { ResponseWindow } from './components/ResponseWindow/index.js';
import { HistoryPanel } from './components/HistoryPanel/index.js';

function getView(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') ?? 'main';
}

export function App(): JSX.Element {
  const view = getView();

  if (view === 'overlay') return <SelectionOverlay />;
  if (view === 'response') return <ResponseWindow />;
  if (view === 'history') return <HistoryPanel />;
  if (view === 'settings') return <div>Settings (P5)</div>;
  if (view === 'first-run') return <div>First-Run Wizard (P5)</div>;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>Glint v2</span>
        <span className={styles.tag}>local-first · pre-alpha</span>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>Bootstrap OK</h1>
        <p className={styles.body}>
          P0 + P1 hotkey scaffold live. Press <code>⌘⇧X</code> to test the marquee overlay.
        </p>
        <code className={styles.code}>⌘⇧X · ⌘⇧H · ⌘,</code>
      </main>
    </div>
  );
}
