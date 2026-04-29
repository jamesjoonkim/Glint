/**
 * Shared TypeScript types used across main, preload, and renderer.
 * Domain types only — no runtime dependencies.
 */

export type ModelRoute = 'text' | 'vision';

export type CaptureBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId: number;
};

export type CaptureResult = {
  id: string;
  pngPath: string;
  ocrText: string;
  ocrConfidence: number;
  textDensity: number;
  route: ModelRoute;
  createdAt: number;
};

export type Turn = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
};

export type Thread = {
  id: string;
  createdAt: number;
  title: string | null;
  pinned: boolean;
};

export type Tag =
  | 'code'
  | 'error'
  | 'article'
  | 'ui'
  | 'diagram'
  | 'photo'
  | 'chart'
  | 'table'
  | 'text'
  | 'other';
