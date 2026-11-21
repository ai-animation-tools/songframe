/**
 * Факты кадра точки съёмки — то, что получат агенты описания и видеопромпта (Go, `internal/viewframe`). Карта
 * показывает их в панели «Что получит агент» до сохранения и запуска; считает их только Go.
 */
import type { ViewpointSide, ViewpointSize } from './viewpoint';

/** Герой на кадре: x от −1 (левый край) до +1 (правый) — только в кадре. */
export interface FrameSubject {
  entity: string;
  lead?: boolean;
  in_frame: boolean;
  x?: number;
  place: string;
  distance: number;
  height?: number;
  frame_height?: number;
  whole?: boolean;
  hidden_by: string[];
}

/** Объект схемы на кадре: x — видимая часть [левый край, правый край], только в кадре. */
export interface FrameObject {
  name: string;
  entity?: string;
  in_frame: boolean;
  x?: [number, number];
  place: string;
  distance: number;
  height?: number;
}

/** Один кадр: куда смотрит камера, её высота, герои и объекты. */
export interface FramePhase {
  looks: string;
  camera_height: number;
  subjects: FrameSubject[];
  objects: FrameObject[];
}

/** Факты кадра; без схемы, без камеры на схеме и у камеры сверху кадров нет, note объясняет почему. */
export interface ViewFrame {
  camera: { side: ViewpointSide; size: ViewpointSize; fov: number };
  note?: string;
  start: FramePhase | null;
  end: FramePhase | null;
}
