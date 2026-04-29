import { useEffect, useRef, useState } from 'react';
import styles from './styles.module.css';
import type { CaptureBBox } from '../../../shared/types.js';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/**
 * Build a normalized rect from a drag start + current cursor.
 * Pure function — exported for unit tests.
 */
export function rectFromPoints(start: Point, current: Point): Rect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

const MIN_SIZE = 4;

export function SelectionOverlay(): JSX.Element {
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.glint?.invoke('capture:cancel').catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    setStart({ x: e.clientX, y: e.clientY });
    setCurrent({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!start) return;
    setCurrent({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    if (!start || !current) return;
    const r = rectFromPoints(start, current);
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) {
      setStart(null);
      setCurrent(null);
      return;
    }
    const bbox: CaptureBBox = { ...r, displayId: 0 }; // displayId resolved by main
    window.glint
      ?.invoke('capture:request', bbox)
      .catch((err) => console.error('capture failed', err));
  };

  const rect = start && current ? rectFromPoints(start, current) : null;
  const dragging = rect !== null;

  return (
    <div
      ref={ref}
      className={styles.root}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {!dragging && (
        <div className={styles.hint}>Drag to select · Esc to cancel</div>
      )}
      {rect && (
        <div
          className={styles.selection}
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
          }}
        />
      )}
    </div>
  );
}
