import type { DashboardShot } from '@shared/types';

const VIDEO_EXTENSION = /\.(?:mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i;

/** Принятый монтаж имеет приоритет; среди загрузок пакета исключаем изображения и прочие файлы. */
export function getSceneVideoPath(shot: DashboardShot): string | null {
  return shot.asset?.video ?? shot.package?.request?.downloads.find((path) => VIDEO_EXTENSION.test(path)) ?? null;
}
