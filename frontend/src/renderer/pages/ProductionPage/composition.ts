/**
 * Снимок вида из камеры для опор: те же кадры, что на виде из камеры точки съёмки, нарисованные в PNG для генератора
 * изображений как схема композиции. Данные и отпечаток приходят из вида плана Go (ProductionComposition), снимок
 * сохраняется обратно productionWorkflow.saveComposition.
 */
import type { ProductionComposition, ProductionCompositionImage } from '@shared/production-workflow';
import { viewpointCamera } from '@shared/viewpoint-camera';
import { figureExtras } from '../../components/CameraFrames';
import { volumeSnapshot } from '../../components/SchemeVolumeView';

/** Размер снимка, px: кадр 16:9, достаточный генератору, чтобы различить фигуры и горизонт. */
export const COMPOSITION_WIDTH = 1280;
export const COMPOSITION_HEIGHT = 720;

/** PNG каждого кадра снимка в base64; без камеры кадра или без WebGL — null. */
export function compositionImages(composition: ProductionComposition): ProductionCompositionImage[] | null {
  const images: ProductionCompositionImage[] = [];
  for (const phase of composition.phases) {
    const camera = viewpointCamera(composition.viewpoint, phase, composition.heights, composition.vehicles);
    if (!camera) return null;
    const extras = figureExtras(composition.viewpoint, phase, composition.heights, composition.vehicles);
    const url = volumeSnapshot(composition.scheme, camera, extras, COMPOSITION_WIDTH, COMPOSITION_HEIGHT);
    if (!url) return null;
    images.push({ phase, data: url.slice(url.indexOf(',') + 1) });
  }
  return images;
}
