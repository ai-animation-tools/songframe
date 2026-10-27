/** Один image request соответствует одной опоре; модель и слоты выбираются до показа платного подтверждения. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaCapabilities } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import { DEFAULT_KLING_IMAGE_GENERATION, type ImageGenerationSettings } from '@shared/types';
import { selectKlingRequest, type PrepareKlingInput } from './media-providers';
import { isImageFile } from './keyframe-images';
import { productionPath } from './production-proposal';

export function frameImageRequest(
  input: ProductionImagesInput,
  settings: ImageGenerationSettings | null | undefined,
  capabilities: MediaCapabilities,
  validateImage: (path: string) => boolean = isImageFile
): PrepareKlingInput {
  if (settings?.provider !== 'kling') throw new Error('Выберите Kling для изображений в настройках проекта.');
  const frame = input.frames[0];
  if (!frame || input.frames.length !== 1) throw new Error('Один платный запрос подготавливается для одной опоры.');
  const command = frame.referencePaths.length ? 'image_to_image' : 'text_to_image';
  const parameters: Record<string, unknown> = { ...(settings.options ?? {}) };
  if (parameters.watermark === true || parameters.watermark === 'true')
    throw new Error('Снимите устаревшую настройку watermark=true: новые изображения запрашиваются без логотипа.');
  for (const [key, value] of [
    ['resolution', settings.resolution ?? DEFAULT_KLING_IMAGE_GENERATION.resolution],
    ['aspect_ratio', settings.aspect_ratio ?? DEFAULT_KLING_IMAGE_GENERATION.aspect_ratio]
  ] as const) {
    if (!value) continue;
    // Явный provider-параметр сохраняем; конфликт двух значений выявит общий валидатор.
    const aliases = key === 'resolution' ? ['resolution', 'img_resolution', 'imgResolution'] : ['aspect_ratio', 'aspectRatio'];
    const alreadySupplied = aliases.some((name) => name in parameters);
    if (!alreadySupplied || settings[key] !== undefined) parameters[key] = value;
  }
  if ([parameters.story_mode, parameters.storyMode].some((value) => value === true || value === 'true'))
    throw new Error('Для одной опоры выберите обычный режим без серии story_mode.');
  const inputs = frame.referencePaths.map((path, index) => {
    // image_N относится к N-му переданному референсу независимо от порядка ключей capabilities.
    const slot = `image_${index + 1}`;
    const full = productionPath(input.project, path);
    if (!isImageFile(full) || !validateImage(full)) throw new Error(`Недоступен референс опоры: ${path}`);
    return { flag: 'input', slot, path: full, role: 'reference' };
  });
  let number = 1;
  while (existsSync(join(input.packageDir, `image-${frame.id}-${number}`))) number++;
  const request: PrepareKlingInput = {
    project: input.project,
    workDir: join(input.packageDir, `image-${frame.id}-${number}`),
    shot: input.shot,
    kind: 'image',
    command,
    model: settings.model?.trim() ?? '',
    preferredModel: settings.model?.trim() || null,
    prompt: frame.prompt,
    parameters,
    outputs: settings.outputs ?? DEFAULT_KLING_IMAGE_GENERATION.outputs ?? 1,
    frameId: frame.id,
    inputs
  };
  return selectKlingRequest(request, capabilities, (model) => {
    const candidate = { ...parameters };
    // Неявный обычный режим добавляем только при наличии объявления; пользовательские options не удаляем.
    if (model.arguments.story_mode && !('story_mode' in candidate) && !('storyMode' in candidate)) candidate.story_mode = false;
    // Старое отдельное предпочтение watermark не ограничивает модель; при объявленном флаге всегда просим без логотипа.
    if (model.arguments.watermark) candidate.watermark = false;
    return candidate;
  });
}
