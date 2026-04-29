import { useCallback, useEffect, useState } from 'react';

export type ChatThreadItem = {
  id: string;
  createdAt: number;
  title: string | null;
  preview: string | null;
  turnCount: number;
  lastTurnAt: number | null;
};

export type ChatThreadsState = {
  items: ChatThreadItem[];
  loading: boolean;
  error: string | null;
};

export function useChatThreads() {
  const [state, setState] = useState<ChatThreadsState>({
    items: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await window.glint?.invoke?.('history:listChats');
      if (Array.isArray(result)) {
        setState({ items: result as ChatThreadItem[], loading: false, error: null });
      } else {
        setState({ items: [], loading: false, error: null });
      }
    } catch (err) {
      setState({ items: [], loading: false, error: String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, load };
}
