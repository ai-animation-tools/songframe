import type { DashboardShot } from '@shared/types';
import { isVideoPath } from '../../components/shotState';

/** Принятый монтаж имеет приоритет; среди загрузок пакета исключаем изображения и прочие файлы. */
export function getSceneVideoPath(shot: DashboardShot): string | null {
  return shot.asset?.video ?? shot.package?.request?.downloads.find(isVideoPath) ?? null;
}
