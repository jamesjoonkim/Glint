import { useCallback, useEffect, useState } from 'react';

export type HistoryItem = {
  id: string;
  createdAt: number;
  pngPath: string;
  thumbPath: string | null;
  ocrText: string | null;
  tags: string[];
  threadId: string;
};

export type HistoryState = {
  items: HistoryItem[];
  loading: boolean;
  error: string | null;
  query: string;
};

function isHistoryArray(payload: unknown): payload is HistoryItem[] {
  return Array.isArray(payload);
}

export function useHistory() {
  const [state, setState] = useState<HistoryState>({
    items: [],
    loading: true,
    error: null,
    query: '',
  });

  const load = useCallback(async (query: string) => {
    setState((s) => ({ ...s, loading: true, error: null, query }));
    try {
      const channel = query.trim() ? 'history:search' : 'history:list';
      const result = await window.glint?.invoke?.(channel, query.trim());
      if (isHistoryArray(result)) {
        setState((s) => ({ ...s, items: result, loading: false }));
      } else {
        setState((s) => ({ ...s, items: [], loading: false }));
      }
    } catch (err) {
      setState((s) => ({ ...s, error: String(err), loading: false }));
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  return { ...state, load };
}
