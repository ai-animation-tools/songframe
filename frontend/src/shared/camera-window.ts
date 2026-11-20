import type { DetachedWindowApi, DetachedWindowEvent } from './detached-window';
import type { Scheme } from './schemes';
import type { SceneViewpoint } from './viewpoint';

/**
 * Отдельное окно вида из камеры точки съёмки. Карта плана в основном окне — владелец: она присылает всё, из чего
 * окно строит кадры, при каждом изменении точки съёмки, схемы или роста героев. Точки правятся только в карте; из
 * окна приходят готовность и зум объектива — новый угол обзора, который карта применяет к точке съёмки.
 */
export interface CameraWindowState {
  /** Заголовок над кадрами: план и локация. */
  title: string;
  scheme: Scheme;
  viewpoint: SceneViewpoint;
  /** Рост героев из кастинга, м. */
  heights: Record<string, number>;
  theme: 'light' | 'dark' | 'system';
  /** Точку съёмки можно править: иначе зум в окне выключен (план принят и не открыт для правки). */
  editable: boolean;
}

export type CameraWindowMessage = { type: 'ready' } | { type: 'state'; state: CameraWindowState } | { type: 'fov'; fov: number };

export type CameraWindowEvent = DetachedWindowEvent<CameraWindowMessage>;

export type CameraWindowApi = DetachedWindowApi<CameraWindowMessage>;
