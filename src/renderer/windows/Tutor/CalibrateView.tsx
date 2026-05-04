import { useCallback, useEffect, useState } from 'react';
import styles from './styles.module.css';

type Label = 'TEACHABLE' | 'SKIP' | 'BORDERLINE' | null;

interface CalibBlock {
  id: string;
  filePath: string;
  raw: string;
  header: string;
  body: string;
  label: Label;
}

interface CalibFile {
  filePath: string;
  date: string;
  blocks: CalibBlock[];
}

const LABELS: Exclude<Label, null>[] = ['TEACHABLE', 'SKIP', 'BORDERLINE'];

export function CalibrateView(): JSX.Element {
  const [files, setFiles] = useState<CalibFile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!window.glint) return;
    setLoading(true);
    try {
      const result = (await window.glint.invoke('tutor:list-calib')) as CalibFile[];
      setFiles(result);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setLabel = async (
    filePath: string,
    blockId: string,
    label: Label,
  ): Promise<void> => {
    if (!window.glint) return;
    // optimistic
    setFiles((curr) =>
      curr.map((f) =>
        f.filePath === filePath
          ? {
              ...f,
              blocks: f.blocks.map((b) => (b.id === blockId ? { ...b, label } : b)),
            }
          : f,
      ),
    );
    await window.glint.invoke('tutor:label-block', { filePath, blockId, label });
  };

  if (loading) return <div className={styles.feedEmpty}>scanning calibration logs…</div>;

  const totalBlocks = files.reduce((s, f) => s + f.blocks.length, 0);
  const labeled = files.reduce(
    (s, f) => s + f.blocks.filter((b) => b.label !== null).length,
    0,
  );

  if (totalBlocks === 0) {
    return (
      <div className={styles.feedEmpty}>
        No calibration entries yet. Lens writes one each time it explains a turn —
        come back after a few sessions.
      </div>
    );
  }

  return (
    <div className={styles.calibRoot}>
      <div className={styles.calibHeader}>
        <span className={styles.calibCounter}>
          {labeled} / {totalBlocks} labeled
        </span>
        <span className={styles.calibHint}>
          target: 30 labeled to derive the gate prompt
        </span>
      </div>
      {files.map((f) => (
        <section key={f.filePath} className={styles.calibFile}>
          <h3 className={styles.calibDate}>{f.date}</h3>
          {f.blocks.map((b) => (
            <article key={b.id} className={styles.calibBlock}>
              <header className={styles.calibBlockHeader}>{b.header}</header>
              <pre className={styles.calibBody}>{b.body}</pre>
              <div className={styles.calibLabelRow}>
                {LABELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={`${styles.calibLabelBtn} ${
                      b.label === l ? styles.calibLabelBtnActive : ''
                    }`}
                    onClick={() => void setLabel(f.filePath, b.id, b.label === l ? null : l)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
