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
  query: string;
};

export function useChatThreads() {
  const [state, setState] = useState<ChatThreadsState>({
    items: [],
    loading: true,
    error: null,
    query: '',
  });

  const load = useCallback(async (query: string = '') => {
    setState((s) => ({ ...s, loading: true, error: null, query }));
    try {
      const channel = query.trim() ? 'history:searchChats' : 'history:listChats';
      const result = await window.glint?.invoke?.(channel, query.trim());
      if (Array.isArray(result)) {
        setState({
          items: result as ChatThreadItem[],
          loading: false,
          error: null,
          query,
        });
      } else {
        setState({ items: [], loading: false, error: null, query });
      }
    } catch (err) {
      setState({ items: [], loading: false, error: String(err), query });
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  return { ...state, load };
}
