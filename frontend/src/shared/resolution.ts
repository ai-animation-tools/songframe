/**
 * Разрешение медиа как число для сравнения: «720p», «1080p», «2k», «1920x1080». Им упорядочиваются
 * варианты разрешения в настройках проекта и определяется, выше ли запрос видео пробного 720p.
 */

/** Пробное разрешение видео: в нём дёшево проверить движение и физику плана до финальной генерации. */
export const PROBE_VIDEO_RESOLUTION = '720p';

/** Размер кадра по стороне квадрата той же площади; нераспознанное значение — 0. */
export function resolutionSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kp])$/i.exec(value);
  if (match) return Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1024 : 16 / 9);
  const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(value);
  return dimensions ? Math.sqrt(Number(dimensions[1]) * Number(dimensions[2])) : 0;
}

/**
 * Совет пробы нужен запросу видео, если его разрешение (параметр resolution запроса) распознано и выше
 * пробного; без разрешения или в пробном разрешении совета нет.
 */
export function probeAdvised(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== 'object') return false;
  const value = (parameters as Record<string, unknown>).resolution;
  if (typeof value !== 'string') return false;
  return resolutionSize(value) > resolutionSize(PROBE_VIDEO_RESOLUTION) + 1e-9;
}
