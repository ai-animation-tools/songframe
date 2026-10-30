/** Общая проверка доступа к сохранённому запросу перед оценкой, отправкой и получением результата. */
import { productionTexts } from '@shared/texts/production';
import { sameMediaProvider, type MediaKind } from '@shared/media-providers';
import { readProjectSettings } from './checks';
import { readPackage } from './production';

const texts = productionTexts.main.access;

export async function requireProductionPackageAccess(
  project: string,
  packageDir: string,
  requireAccess: (project: string, kind: MediaKind) => Promise<void>
): Promise<void> {
  const request = readPackage(project, packageDir)?.request;
  if (!request) throw new Error(texts.savedRequestRequired);
  if (!request.provider) throw new Error(texts.requestProviderMissing);
  const kind = request.kind === 'image' ? 'image' : 'video';
  await requireAccess(project, kind);
  // Регистр и крайние пробелы в имени провайдера несущественны; другой провайдер по-прежнему требует нового запроса.
  if (!sameMediaProvider(readProjectSettings(project).generation?.[kind]?.provider, request.provider)) throw new Error(texts.mediaProviderChanged);
}
