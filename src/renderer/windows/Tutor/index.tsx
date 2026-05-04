import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionPicker } from './SessionPicker.js';
import { TurnFeed } from './TurnFeed.js';
import { CalibrateView } from './CalibrateView.js';
import { PromptView } from './PromptView.js';
import type { CardTurn } from './EventCard.js';
import styles from './styles.module.css';

type Mode = 'feed' | 'calibrate' | 'prompt';

interface Session {
  jsonlPath: string;
  cwd: string;
  primary: string;
  secondary?: string;
  sessionUuid: string;
  mtimeMs: number;
  sizeBytes: number;
  active: boolean;
}

interface TurnStartEvent {
  kind: 'turn-start';
  historical?: boolean;
  turn: {
    turnIdx: number;
    turnId?: string;
    timestamp: string;
    userPrompt: string;
    reasoning: string;
    tools: {
      name: string;
      input: Record<string, unknown>;
      id?: string;
      result?: string | null;
      resultError?: boolean;
    }[];
    diffs: { file: string; old: string; new: string }[];
    mess?: {
      rule: string;
      label: string;
      reason: string;
      file: string;
      severity: 'info' | 'warn' | 'error';
    }[];
  };
}

interface ChunkEvent {
  turnIdx: number;
  chunk: string;
}

interface DoneEvent {
  turnIdx: number;
  turnId?: string;
  full: string;
  historical?: boolean;
  fromCache?: boolean;
}

function getInitialJsonlPath(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('jsonl');
}

function useEscapeToClose(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Tutor(): JSX.Element {
  useEscapeToClose();
  const [picked, setPicked] = useState<Session | null>(null);
  const [mode, setMode] = useState<Mode>('feed');
  const [turns, setTurns] = useState<CardTurn[]>([]);
  const [bulkN, setBulkN] = useState('10');
  const turnsRef = useRef<Map<number, CardTurn>>(new Map());

  const unexplainedCount = turns.filter(
    (t) =>
      t.historical &&
      (!t.explanation || t.explanation.trim().toUpperCase() === 'SKIP'),
  ).length;

  const onBulk = async (): Promise<void> => {
    if (!window.glint) return;
    const n = parseInt(bulkN, 10);
    await window.glint.invoke('tutor:explain-bulk', {
      count: Number.isFinite(n) && n > 0 ? n : 10,
    });
  };

  // URL-param deep-link: ?jsonl=<path> auto-picks the session and skips
  // the picker entirely. Used when the user clicks a row from the
  // dashboard's LENS tab.
  useEffect(() => {
    if (picked) return;
    const jsonlPath = getInitialJsonlPath();
    if (!jsonlPath || !window.glint) return;
    void (async () => {
      if (!window.glint) return;
      const list = (await window.glint.invoke('tutor:list-sessions')) as Session[];
      const match = list.find((s) => s.jsonlPath === jsonlPath);
      if (match) setPicked(match);
    })();
  }, [picked]);

  const updateTurns = useCallback(() => {
    const arr = Array.from(turnsRef.current.values()).sort(
      (a, b) => a.turnIdx - b.turnIdx,
    );
    setTurns(arr);
  }, []);

  // Subscribe to push channels whenever a session is picked.
  useEffect(() => {
    if (!picked || !window.glint) return;

    turnsRef.current = new Map();
    setTurns([]);

    const offTurn = window.glint.subscribe('tutor:event', (_e, payload) => {
      const ev = payload as TurnStartEvent;
      if (ev?.kind !== 'turn-start') return;
      const t = ev.turn;
      const existing = turnsRef.current.get(t.turnIdx);
      // If we already have this card and the new event is "live" — the user
      // re-requested explain on a previously historical turn. Promote to live
      // so the streaming UI takes over.
      if (existing && ev.historical === false) {
        turnsRef.current.set(t.turnIdx, {
          ...existing,
          ...t,
          turnId: t.turnId ?? existing.turnId,
          historical: false,
          explanation: '',
          explanationDone: false,
          explaining: true,
        });
      } else {
        turnsRef.current.set(t.turnIdx, {
          ...t,
          turnId: t.turnId ?? `idx-${t.turnIdx}`,
          explanation: '',
          // Historical turns mark done immediately so spinner doesn't run.
          explanationDone: ev.historical === true,
          historical: ev.historical === true,
        });
      }
      updateTurns();
    });

    const offChunk = window.glint.subscribe('tutor:explain:chunk', (_e, payload) => {
      const ev = payload as ChunkEvent;
      const existing = turnsRef.current.get(ev.turnIdx);
      if (!existing) return;
      turnsRef.current.set(ev.turnIdx, {
        ...existing,
        explanation: existing.explanation + ev.chunk,
        explaining: true,
      });
      updateTurns();
    });

    const offDone = window.glint.subscribe('tutor:explain:done', (_e, payload) => {
      const ev = payload as DoneEvent;
      const existing = turnsRef.current.get(ev.turnIdx);
      if (!existing) return;
      turnsRef.current.set(ev.turnIdx, {
        ...existing,
        explanation: ev.full || existing.explanation,
        explanationDone: true,
        explaining: false,
        fromCache: ev.fromCache === true,
      });
      updateTurns();
    });

    void window.glint.invoke('tutor:watch-session', {
      jsonlPath: picked.jsonlPath,
      cwd: picked.cwd,
    });

    return () => {
      offTurn();
      offChunk();
      offDone();
      // NOTE: intentionally NOT calling stop-watching here. React 18
      // StrictMode runs effects twice in dev (mount → cleanup → mount),
      // which would abort the initial MLX stream and leave the second
      // mount with a fresh tailer that can't recover the cut explanation.
      // Stop is handled by main when the window closes (see ipc.ts).
    };
  }, [picked, updateTurns]);

  // Deep-link from dashboard tab — pre-select a session by jsonlPath.
  useEffect(() => {
    if (picked || !window.glint) return;
    const off = window.glint.subscribe('tutor:deep-link', (_e, payload) => {
      const p = payload as { jsonlPath?: string };
      if (!p?.jsonlPath) return;
      // Fetch sessions to resolve full Session shape, then pick.
      void (async () => {
        if (!window.glint) return;
        const list = (await window.glint.invoke('tutor:list-sessions')) as Session[];
        const match = list.find((s) => s.jsonlPath === p.jsonlPath);
        if (match) setPicked(match);
      })();
    });
    return off;
  }, [picked]);

  if (!picked) return <SessionPicker onPick={setPicked} />;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => setPicked(null)}
        >
          ← all sessions
        </button>
        <p className={styles.title}>Watching</p>
        <h1 className={styles.heading}>{picked.primary}</h1>
        <p className={styles.subhead}>
          {picked.secondary ? `${picked.secondary} · ` : ''}
          session {picked.sessionUuid.slice(0, 8)}
        </p>
        <nav className={styles.modeNav} aria-label="Lens view">
          {(['feed', 'calibrate', 'prompt'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.modeBtn} ${mode === m ? styles.modeBtnActive : ''}`}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
          {mode === 'feed' && unexplainedCount > 0 && (
            <span className={styles.bulkInline}>
              <span className={styles.bulkLabel}>
                {unexplainedCount} unexplained
              </span>
              <span className={styles.bulkInlineGroup}>
                explain last
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={bulkN}
                  onChange={(e) => setBulkN(e.target.value)}
                  className={styles.bulkInput}
                />
                <button type="button" onClick={onBulk} className={styles.bulkBtn}>
                  run
                </button>
              </span>
            </span>
          )}
        </nav>
      </header>
      {mode === 'feed' && <TurnFeed turns={turns} />}
      {mode === 'calibrate' && <CalibrateView />}
      {mode === 'prompt' && <PromptView />}
    </div>
  );
}
