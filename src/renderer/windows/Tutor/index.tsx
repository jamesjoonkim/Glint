import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionPicker } from './SessionPicker.js';
import { TurnFeed } from './TurnFeed.js';
import type { CardTurn } from './EventCard.js';
import styles from './styles.module.css';

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
    timestamp: string;
    userPrompt: string;
    reasoning: string;
    tools: { name: string; input: Record<string, unknown> }[];
    diffs: { file: string; old: string; new: string }[];
  };
}

interface ChunkEvent {
  turnIdx: number;
  chunk: string;
}

interface DoneEvent {
  turnIdx: number;
  full: string;
  historical?: boolean;
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
  const [turns, setTurns] = useState<CardTurn[]>([]);
  const turnsRef = useRef<Map<number, CardTurn>>(new Map());

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
      turnsRef.current.set(t.turnIdx, {
        ...t,
        explanation: '',
        // Historical turns are pre-marked done so the spinner doesn't run
        // forever waiting for an explanation that's not coming.
        explanationDone: ev.historical === true,
        historical: ev.historical === true,
      });
      updateTurns();
    });

    const offChunk = window.glint.subscribe('tutor:explain:chunk', (_e, payload) => {
      const ev = payload as ChunkEvent;
      const existing = turnsRef.current.get(ev.turnIdx);
      if (!existing) return;
      turnsRef.current.set(ev.turnIdx, {
        ...existing,
        explanation: existing.explanation + ev.chunk,
      });
      updateTurns();
    });

    const offDone = window.glint.subscribe('tutor:explain:done', (_e, payload) => {
      const ev = payload as DoneEvent;
      const existing = turnsRef.current.get(ev.turnIdx);
      if (!existing) return;
      turnsRef.current.set(ev.turnIdx, {
        ...existing,
        explanation: ev.full,
        explanationDone: true,
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
      </header>
      <TurnFeed turns={turns} />
    </div>
  );
}
