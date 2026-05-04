import { useCallback, useEffect, useState } from 'react';

export interface LensSession {
  jsonlPath: string;
  cwd: string;
  primary: string;
  secondary?: string;
  sessionUuid: string;
  mtimeMs: number;
  sizeBytes: number;
  active: boolean;
}

export function useLensSessions(): {
  items: LensSession[];
  loading: boolean;
  refresh: () => Promise<void>;
  activeCount: number;
} {
  const [items, setItems] = useState<LensSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!window.glint) return;
    setLoading(true);
    try {
      const result = (await window.glint.invoke('tutor:list-sessions')) as LensSession[];
      setItems(result);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Light polling so the active dot stays fresh while user lingers.
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return {
    items,
    loading,
    refresh,
    activeCount: items.filter((s) => s.active).length,
  };
}
