/** Общая проверка доступа к сохранённому запросу перед оценкой, отправкой и получением результата. */
import { sameMediaProvider, type MediaKind } from '@shared/media-providers';
import { readProjectSettings } from './checks';
import { readPackage } from './production';

export async function requireProductionPackageAccess(
  project: string,
  packageDir: string,
  requireAccess: (project: string, kind: MediaKind) => Promise<void>
): Promise<void> {
  const request = readPackage(project, packageDir)?.request;
  if (!request) throw new Error('В пакете нет сохранённого запроса.');
  if (!request.provider) throw new Error('В сохранённом запросе не указан провайдер.');
  const kind = request.kind === 'image' ? 'image' : 'video';
  await requireAccess(project, kind);
  // Регистр и крайние пробелы в имени провайдера несущественны; другой провайдер по-прежнему требует нового запроса.
  if (!sameMediaProvider(readProjectSettings(project).generation?.[kind]?.provider, request.provider))
    throw new Error('Провайдер медиа изменился. Подготовьте новый запрос для выбранного провайдера.');
}
