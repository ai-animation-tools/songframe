/** Один image request соответствует одной опоре; модель и слоты выбираются до показа платного подтверждения. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_PROVIDERS, sameMediaProvider, type MediaCapabilities } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import type { ImageGenerationSettings } from '@shared/types';
import { selectPaidRequest, type PreparePaidInput } from './media-providers';
import type { PaidProviderAdapter } from './providers/types';
import { isImageFile } from './keyframe-images';
import { productionPath } from './production-proposal';

export function frameImageRequest(
  adapter: Pick<PaidProviderAdapter, 'id' | 'rules'>,
  input: ProductionImagesInput,
  settings: ImageGenerationSettings | null | undefined,
  capabilities: MediaCapabilities,
  validateImage: (path: string) => boolean = isImageFile
): PreparePaidInput {
  const info = MEDIA_PROVIDERS[adapter.id];
  const { rules } = adapter;
  if (!settings || !sameMediaProvider(settings.provider, adapter.id)) throw new Error(`Выберите ${info.title} для изображений в настройках проекта.`);
  const frame = input.frames[0];
  if (!frame || input.frames.length !== 1) throw new Error('Один платный запрос подготавливается для одной опоры.');
  const parameters: Record<string, unknown> = { ...(settings.options ?? {}) };
  for (const [name, rule] of Object.entries(rules.enforced)) if (rule.rejected.includes(parameters[name])) throw new Error(rule.message);
  const defaults = info.defaults.image ?? {};
  for (const [key, value] of [
    ['resolution', settings.resolution ?? defaults.resolution],
    ['aspect_ratio', settings.aspect_ratio ?? defaults.aspect_ratio]
  ] as const) {
    if (!value) continue;
    // Явный provider-параметр сохраняем; конфликт двух значений выявит общий валидатор.
    const aliases = rules.aliases.image?.[key] ?? [key];
    const alreadySupplied = aliases.some((name) => name in parameters);
    if (!alreadySupplied || settings[key] !== undefined) parameters[key] = value;
  }
  const series = rules.image.series;
  if (series?.names.some((name) => parameters[name] === true || parameters[name] === 'true'))
    throw new Error(`Для одной опоры выберите обычный режим без серии ${series.names[0]}.`);
  const inputs = frame.referencePaths.map((path, index) => {
    const full = productionPath(input.project, path);
    if (!isImageFile(full) || !validateImage(full)) throw new Error(`Недоступен референс опоры: ${path}`);
    return { flag: 'input', slot: rules.image.referenceSlot(index), path: full, role: 'reference' };
  });
  let number = 1;
  while (existsSync(join(input.packageDir, `image-${frame.id}-${number}`))) number++;
  const request: PreparePaidInput = {
    project: input.project,
    workDir: join(input.packageDir, `image-${frame.id}-${number}`),
    shot: input.shot,
    kind: 'image',
    command: rules.image.command(frame.referencePaths.length),
    model: settings.model?.trim() ?? '',
    preferredModel: settings.model?.trim() || null,
    prompt: frame.prompt,
    parameters,
    outputs: settings.outputs ?? defaults.outputs ?? 1,
    frameId: frame.id,
    inputs
  };
  return selectPaidRequest(adapter, request, capabilities, (model) => {
    const candidate = { ...parameters };
    // Неявный обычный режим добавляем только при наличии объявления; пользовательские options не удаляем.
    const declared = series?.names.find((name) => name in model.arguments);
    if (series && declared && !series.names.some((name) => name in candidate)) candidate[declared] = series.off;
    return candidate;
  });
}
