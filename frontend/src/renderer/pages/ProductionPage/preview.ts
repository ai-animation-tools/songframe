import type { ShotProduction } from '@shared/types';
import { isVideoPath } from '../../components/shotState';

/**
 * Предпросмотр карточки плана: принятое видео, иначе результат последнего пакета, иначе его опора или скачанное изображение.
 * Пакеты перечислены от старых к новым, поэтому берём последние материалы.
 */
export function shotPreview(shot: ShotProduction): { videoPath: string | null; imagePath: string | null } {
  const packages = [...shot.packages].reverse();
  const videoPath = shot.asset?.video ?? packages.flatMap((pkg) => pkg.request?.downloads ?? []).find(isVideoPath) ?? null;
  const imagePath =
    packages.flatMap((pkg) => pkg.keyframes.map((frame) => frame.imagePath)).find((path): path is string => !!path) ??
    packages.flatMap((pkg) => pkg.request?.downloads ?? []).find((path) => !isVideoPath(path)) ??
    null;
  return { videoPath, imagePath };
}
