import { useCallback, useEffect, useState } from 'react';
import styles from './styles.module.css';

interface PromptInfo {
  active: string;
  defaultText: string;
  isCustom: boolean;
}

export function PromptView(): JSX.Element {
  const [info, setInfo] = useState<PromptInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const load = useCallback(async () => {
    if (!window.glint) return;
    const result = (await window.glint.invoke('tutor:get-prompt')) as PromptInfo;
    setInfo(result);
    setDraft(result.active);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (!window.glint) return;
    const r = (await window.glint.invoke('tutor:set-prompt', { text: draft })) as { ok: boolean };
    setStatus(r.ok ? 'saved' : 'error');
    setTimeout(() => setStatus('idle'), 1200);
    await load();
  };

  const reset = async (): Promise<void> => {
    if (!window.glint) return;
    await window.glint.invoke('tutor:reset-prompt');
    await load();
  };

  if (!info) return <div className={styles.feedEmpty}>loading prompt…</div>;

  const dirty = draft !== info.active;
  return (
    <div className={styles.promptRoot}>
      <div className={styles.promptMeta}>
        <span>
          {info.isCustom ? 'CUSTOM' : 'DEFAULT'}
          {dirty && <span className={styles.promptDirty}> · unsaved</span>}
        </span>
        <span className={styles.calibHint}>
          changes apply to the next turn — no restart needed
        </span>
      </div>
      <textarea
        className={styles.promptArea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
      />
      <div className={styles.promptActions}>
        <button
          type="button"
          className={styles.promptBtnPrimary}
          onClick={save}
          disabled={!dirty}
        >
          {status === 'saved' ? '✓ saved' : 'save'}
        </button>
        <button
          type="button"
          className={styles.promptBtn}
          onClick={() => setDraft(info.defaultText)}
        >
          revert to default
        </button>
        {info.isCustom && (
          <button type="button" className={styles.promptBtn} onClick={reset}>
            clear override
          </button>
        )}
      </div>
    </div>
  );
}
