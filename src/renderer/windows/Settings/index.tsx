import { useState } from 'react';
import styles from './styles.module.css';

type Tab = 'models' | 'hotkeys' | 'storage' | 'about';

export function Settings(): JSX.Element {
  const [tab, setTab] = useState<Tab>('models');

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <h2 className={styles.brand}>Settings</h2>
        <nav className={styles.nav}>
          <NavItem id="models" label="Models" active={tab} onSelect={setTab} />
          <NavItem id="hotkeys" label="Hotkeys" active={tab} onSelect={setTab} />
          <NavItem id="storage" label="Storage" active={tab} onSelect={setTab} />
          <NavItem id="about" label="About" active={tab} onSelect={setTab} />
        </nav>
      </aside>
      <main className={styles.body}>
        {tab === 'models' && <ModelsTab />}
        {tab === 'hotkeys' && <HotkeysTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  );
}

function NavItem({
  id,
  label,
  active,
  onSelect,
}: {
  id: Tab;
  label: string;
  active: Tab;
  onSelect: (t: Tab) => void;
}) {
  return (
    <button
      className={`${styles.navItem} ${active === id ? styles.navItemActive : ''}`}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

function ModelsTab(): JSX.Element {
  return (
    <section>
      <h3>Local models</h3>
      <p className={styles.body}>
        Manage the local Qwen2.5, Qwen3-VL, and BGE-small models. Re-download,
        remove, or switch to a smaller variant if you're running on 8 GB.
      </p>
      <p className={styles.note}>Wire-up lands in v2.0 RC.</p>
    </section>
  );
}

function HotkeysTab(): JSX.Element {
  return (
    <section>
      <h3>Hotkeys</h3>
      <ul className={styles.kvList}>
        <li>
          <span>Capture</span>
          <code>⌘⇧X</code>
        </li>
        <li>
          <span>History</span>
          <code>⌘⇧H</code>
        </li>
        <li>
          <span>Settings</span>
          <code>⌘,</code>
        </li>
      </ul>
      <p className={styles.note}>Rebinding lands in v2.0 RC.</p>
    </section>
  );
}

function StorageTab(): JSX.Element {
  return (
    <section>
      <h3>Storage</h3>
      <p className={styles.body}>
        Captures and history live in <code>~/Library/Application Support/Glint/</code>.
        Verify FileVault is on so the directory is encrypted at rest.
      </p>
      <p className={styles.note}>Disk-usage view + clear-history button land in v2.0 RC.</p>
    </section>
  );
}

function AboutTab(): JSX.Element {
  const onLogs = () =>
    window.glint?.invoke('settings:open', { reveal: 'logs' }).catch(() => {});
  return (
    <section>
      <h3>About</h3>
      <p className={styles.body}>
        Glint v2.0.0-alpha · local-first screenshot assistant
      </p>
      <p className={styles.body}>
        <a href="https://github.com/JamaJKIM/Glint" rel="noreferrer" target="_blank">
          github.com/JamaJKIM/Glint
        </a>
      </p>
      <button className={styles.button} onClick={onLogs}>
        Open Logs in Finder
      </button>
    </section>
  );
}
