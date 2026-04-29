import { useEffect, useRef, useState } from 'react';

export type StreamState = {
  text: string;
  done: boolean;
  error: string | null;
};

/**
 * Subscribe to a model token stream from the main process and accumulate text
 * into a single buffer. Re-renders are batched via requestAnimationFrame so we
 * don't churn the renderer when tokens arrive faster than 60fps.
 */
export function useStream(streamId: string | null): StreamState {
  const [state, setState] = useState<StreamState>({ text: '', done: false, error: null });
  const bufferRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streamId) return;
    bufferRef.current = '';
    setState({ text: '', done: false, error: null });

    const flush = () => {
      rafRef.current = null;
      setState((prev) => ({ ...prev, text: bufferRef.current }));
    };

    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flush);
    };

    const isMatch = (payload: unknown): payload is { id: string } =>
      typeof payload === 'object' &&
      payload !== null &&
      'id' in payload &&
      (payload as { id: unknown }).id === streamId;

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
  }, [streamId]);

  return state;
}
