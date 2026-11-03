import type { TimingFile } from './types';

/** Временный адрес выбранного файла принадлежит одному запуску медиасервера и не сохраняется в проект. */
export interface MediaFile {
  path: string;
  url: string;
  kind: 'audio' | 'video';
}
/** Read-only срез не подменяет полный производственный ProjectStatus; blocked не разрешает показ частичной публикации. */
/** Старые документы могут не содержать метаданные и sections; просмотр не дописывает их значениями по умолчанию. */
export type ReadonlyTiming = Pick<TimingFile, 'lines'> & Partial<Omit<TimingFile, 'lines' | 'version'>> & { version?: number };
export interface ProjectSnapshot {
  path: string;
  name: string;
  lyricsText: string;
  timing: ReadonlyTiming | null;
  track: MediaFile | null;
  trackSha256: string | null;
  duration: number | null;
  problems: string[];
  blocked: boolean;
}
/** Модель отдельного окна читается по session через Go; адрес из параметров URL не принимается. */
export interface PreviewInput {
  session: string;
  mediaUrl: string;
  title: string;
}
/** Пути поступают из события Wails ОС, а не из имени браузерного File. */
export interface FilesDropped {
  windowID: number;
  paths: string[];
  targetID: string;
}
