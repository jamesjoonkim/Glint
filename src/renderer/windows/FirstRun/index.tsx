import { useState } from 'react';
import styles from './styles.module.css';

type Step = 'welcome' | 'permissions' | 'models' | 'done';

export function FirstRun(): JSX.Element {
  const [step, setStep] = useState<Step>('welcome');

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        {step === 'welcome' && (
          <Welcome onNext={() => setStep('permissions')} />
        )}
        {step === 'permissions' && (
          <Permissions onNext={() => setStep('models')} />
        )}
        {step === 'models' && <ModelsStep onNext={() => setStep('done')} />}
        {step === 'done' && <Done />}
      </div>
      <Stepper current={step} />
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <>
      <h1 className={styles.title}>Welcome to Glint</h1>
      <p className={styles.body}>
        A local-first AI assistant that explains anything on your screen.
        Press <code>⌘⇧X</code>, drag to select a region, and Glint hands the result
        to a model running entirely on your Mac. After this one-time setup,
        no data leaves your machine.
      </p>
      <button className={styles.primary} onClick={onNext}>
        Continue
      </button>
    </>
  );
}

function Permissions({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <>
      <h1 className={styles.title}>Screen Recording permission</h1>
      <p className={styles.body}>
        macOS requires explicit permission for screen capture. The next prompt
        will ask you to enable Glint in System Settings → Privacy & Security →
        Screen Recording. After granting, return here.
      </p>
      <button
        className={styles.primary}
        onClick={() =>
          window.glint
            ?.invoke('settings:open', { tab: 'permissions' })
            .catch(() => {})
            .finally(onNext)
        }
      >
        Grant permission
      </button>
      <button className={styles.secondary} onClick={onNext}>
        I'll do it later
      </button>
    </>
  );
}

function ModelsStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <>
      <h1 className={styles.title}>Download local models</h1>
      <p className={styles.body}>
        Glint needs three local models. Roughly <strong>10 GB</strong> total.
        You can skip the vision model and run text-only — most captures (code,
        errors, articles) work great on text alone.
      </p>
      <ul className={styles.list}>
        <li>Qwen2.5-7B (text answers) — ~4 GB · required</li>
        <li>Qwen2-VL-7B (vision answers) — ~6 GB · optional</li>
        <li>BGE-small (semantic search) — ~30 MB · required</li>
      </ul>
      <p className={styles.note}>
        For the alpha, downloads run on first launch via the bundled runtime.
        Wire-up lands in P5 final.
      </p>
      <button className={styles.primary} onClick={onNext}>
        Skip for now
      </button>
    </>
  );
}

function Done(): JSX.Element {
  return (
    <>
      <h1 className={styles.title}>Ready</h1>
      <p className={styles.body}>
        Press <code>⌘⇧X</code> anywhere to capture. <code>⌘⇧H</code> to browse
        history. <code>⌘,</code> for settings.
      </p>
    </>
  );
}

function Stepper({ current }: { current: Step }): JSX.Element {
  const steps: Step[] = ['welcome', 'permissions', 'models', 'done'];
  const idx = steps.indexOf(current);
  return (
    <div className={styles.stepper}>
      {steps.map((s, i) => (
        <span
          key={s}
          className={`${styles.dot} ${i <= idx ? styles.dotActive : ''}`}
          aria-current={i === idx ? 'step' : undefined}
        />
      ))}
    </div>
  );
}
