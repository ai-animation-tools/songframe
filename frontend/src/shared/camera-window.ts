import type { DetachedWindowApi, DetachedWindowEvent } from './detached-window';
import type { Scheme } from './schemes';
import type { SceneViewpoint } from './viewpoint';

/**
 * Отдельное окно вида из камеры точки съёмки. Карта плана в основном окне — владелец: она присылает всё, из чего
 * окно строит кадры, при каждом изменении точки съёмки, схемы или роста героев. Окно только показывает кадры —
 * правится всё в карте, поэтому обратно окно сообщает лишь о готовности.
 */
export interface CameraWindowState {
  /** Заголовок над кадрами: план и локация. */
  title: string;
  scheme: Scheme;
  viewpoint: SceneViewpoint;
  /** Рост героев из кастинга, м. */
  heights: Record<string, number>;
  theme: 'light' | 'dark' | 'system';
}

export type CameraWindowMessage = { type: 'ready' } | { type: 'state'; state: CameraWindowState };

export type CameraWindowEvent = DetachedWindowEvent<CameraWindowMessage>;

export type CameraWindowApi = DetachedWindowApi<CameraWindowMessage>;
