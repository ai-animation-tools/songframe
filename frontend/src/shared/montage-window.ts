import type { MontageDraft } from './montage';

/** Состояние передаётся только при изменении монтажа или явной перемотке; кадры идут отдельно. */
export interface MontageWindowState {
  project: string;
  draft: MontageDraft;
  trackUrl: string | null;
  frame: number;
  seekVersion: number;
  selectedClipId: string | null;
  suspended: boolean;
  theme: 'light' | 'dark' | 'system';
  loop: boolean;
  volume: number;
}

export type MontageWindowMessage =
  | { type: 'ready' }
  | { type: 'state'; state: MontageWindowState }
  | { type: 'frame'; frame: number }
  | { type: 'metadata'; path: string; frames: number }
  | { type: 'trackFrames'; frames: number }
  | { type: 'preferences'; loop: boolean; volume: number }
  | { type: 'command'; action: 'toggle' | 'previousFrame' | 'nextFrame' };

export interface MontageWindowEvent {
  session: string;
  message: MontageWindowMessage;
}

export interface MontageWindowApi {
  open(session: string): Promise<void>;
  close(session: string): Promise<void>;
  send(message: MontageWindowMessage): void;
  onMessage(listener: (event: MontageWindowEvent) => void): () => void;
  onClosed(listener: (session: string) => void): () => void;
}
