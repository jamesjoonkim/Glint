import { useEffect, useRef, useState } from 'react';

export type StreamState = {
  text: string;
  done: boolean;
  error: string | null;
};

export type StreamHandle = StreamState & {
  /**
   * Set the active stream id SYNCHRONOUSLY. Call this from the IPC handler
   * for `response:set-stream` BEFORE main has a chance to fire the first
   * token — passing through React state would lose tokens to the render
   * cycle gap.
   */
  setStreamId: (id: string | null) => void;
};

/**
 * Subscribe to a model token stream from the main process and accumulate
 * text into a single buffer. Re-renders are batched via requestAnimationFrame
 * so we don't churn the renderer when tokens arrive faster than 60fps.
 *
 * Subscriptions register ONCE on mount (not per-streamId) — otherwise the
 * subscribe call lands AFTER main has already started firing tokens for the
 * round, dropping the first events and the done event with them. The current
 * streamId lives in a ref; listeners filter by that ref so events for stale
 * streams are ignored. setStreamId() updates the ref synchronously so a
 * stream that switches mid-tick doesn't drop its first chunk.
 */
export function useStream(initialStreamId: string | null = null): StreamHandle {
  const [state, setState] = useState<StreamState>({ text: '', done: false, error: null });
  const bufferRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);
  const streamIdRef = useRef<string | null>(initialStreamId);

  const setStreamId = (id: string | null): void => {
    streamIdRef.current = id;
    bufferRef.current = '';
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setState({ text: '', done: false, error: null });
  };

  useEffect(() => {
    const flush = () => {
      rafRef.current = null;
      setState((prev) => ({ ...prev, text: bufferRef.current }));
    };

    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flush);
    };

    const isMatch = (payload: unknown): boolean => {
      const id = streamIdRef.current;
      if (!id) return false;
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'id' in payload &&
        (payload as { id: unknown }).id === id
      );
    };

    const onToken = (_e: unknown, payload: unknown) => {
      if (!isMatch(payload)) return;
      const chunk = (payload as { chunk?: unknown }).chunk;
      if (typeof chunk !== 'string') return;
      bufferRef.current += chunk;
      schedule();
    };

    const onDone = (_e: unknown, payload: unknown) => {
      if (!isMatch(payload)) return;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      setState({ text: bufferRef.current, done: true, error: null });
    };

    const onError = (_e: unknown, payload: unknown) => {
      if (!isMatch(payload)) return;
      const error = (payload as { error?: unknown }).error;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      setState({
        text: bufferRef.current,
        done: true,
        error: typeof error === 'string' ? error : 'unknown error',
      });
    };

    const off = window.glint?.subscribe?.('model:stream:token', onToken);
    const offDone = window.glint?.subscribe?.('model:stream:done', onDone);
    const offErr = window.glint?.subscribe?.('model:stream:error', onError);

    return () => {
      off?.();
      offDone?.();
      offErr?.();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { ...state, setStreamId };
}
