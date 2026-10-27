/** Контракт ручного монтажа; общая кадровая сетка находится в video.ts; @link ../../docs/montage.md. */
import type { JobInfo } from './types';
import type { ScenarioStatus } from './scenario-status';

export interface MontageClip {
  id: string;
  scene: string;
  /** Путь от корня выбранного проекта, без привязки к компьютеру. */
  path: string;
  kind: 'video' | 'card';
  source_start_frame: number;
  source_end_frame_exclusive: number;
  /** Из метаданных исходника; для видео без метаданных заполняется после загрузки в плеере. */
  source_frames: number | null;
}

export interface MontageDraft {
  schema_version: 1;
  name: string;
  audio: { path: string; start_frame: number; end_frame_exclusive: number };
  clips: MontageClip[];
  /** Снимок реестра и комплектов нужен только для явного применения к сценам. */
  base_scenes_sha256: string;
  base_manifest_sha256: Record<string, string>;
}

export interface MontageSource {
  id: string;
  scene: string;
  title: string;
  label: string;
  path: string;
  kind: 'video' | 'card';
  frames: number | null;
  /** Оригинал разрешает расширять монтаж в пределах полного ролика. */
  original: boolean;
}

export interface MontageScene {
  id: string;
  title: string;
  startFrame: number;
  endFrame: number;
}

export interface MontageSaved {
  id: string;
  name: string;
  updatedAt: string;
}

/** Границы текста находятся на абсолютной кадровой оси исходной песни. */
export interface MontageLyricLine {
  id: number;
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface MontageView {
  /** Без доступного сценария рабочие инструменты монтажа не показываются. */
  scenarioStatus: ScenarioStatus;
  /** Путь от корня проекта; для воспроизведения преобразуется через fileUrl. */
  trackPath: string | null;
  trackSha256: string | null;
  duration: number | null;
  lyricLines: MontageLyricLine[];
  lyricProblem: string | null;
  scenes: MontageScene[];
  sources: MontageSource[];
  scenesSha256: string;
  manifestSha256: Record<string, string>;
  saved: MontageSaved[];
  problems: string[];
}

export interface MontageExport {
  job: JobInfo;
  video: string;
}

export interface MontageApi {
  view(project: string): Promise<MontageView>;
  load(project: string, id: string): Promise<MontageDraft>;
  save(project: string, draft: MontageDraft, id?: string): Promise<MontageSaved>;
  export(project: string, draft: MontageDraft): Promise<MontageExport>;
  /** Применение меняет только перечисленные сцены; перенос стыка включает обоих соседей. */
  apply(project: string, draft: MontageDraft): Promise<JobInfo>;
  /** Копирует готовую пробу в выбранный пользователем MP4. */
  saveVideo(project: string, video: string): Promise<string | null>;
}
