import type { ShotProduction } from '@shared/types';
import { isVideoPath } from '../../components/shotState';

/**
 * Изображение карточки плана: первая опора из папки принятого комплекта, без комплекта — первая опора последней
 * попытки с опорами, иначе скачанное изображение. Видео карточка не показывает: десятки видео в сетке держат по
 * декодеру на каждое и вешают страницу. Пакеты перечислены от старых к новым, поэтому берём последние материалы.
 */
export function shotImage(shot: ShotProduction): string | null {
  const packages = [...shot.packages].reverse();
  return (
    shot.asset?.frame ??
    packages.flatMap((pkg) => pkg.keyframes.map((frame) => frame.imagePath)).find((path): path is string => !!path) ??
    packages.flatMap((pkg) => pkg.request?.downloads ?? []).find((path) => !isVideoPath(path)) ??
    null
  );
}
