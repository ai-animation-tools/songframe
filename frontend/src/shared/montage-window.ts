import type { DetachedWindowApi, DetachedWindowEvent } from './detached-window';
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

export type MontageWindowEvent = DetachedWindowEvent<MontageWindowMessage>;

/** Отдельное окно плеера монтажа. */
export type MontageWindowApi = DetachedWindowApi<MontageWindowMessage>;
