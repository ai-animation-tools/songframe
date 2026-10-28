/** Особенности конкретного сервиса агент получает только для провайдера, выбранного в проекте: из раздела его документа. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaProviderInfo, normalizeMediaProvider, type MediaKind } from '@shared/media-providers';

export const PROVIDER_GUIDE_HEADING = '## Указания агенту';

/** Путь документа провайдера относительно корня комплекса (в поставке — resources). */
export function providerDocPath(root: string, kind: MediaKind, id: string): string {
  return join(root, 'docs/providers', kind, `${id}.md`);
}

/** Раздел «Указания агенту» документа выбранного провайдера с заголовком для промпта; null — провайдер не выбран или раздела нет. */
export function providerGuide(root: string, kind: MediaKind, provider: unknown): string | null {
  const id = normalizeMediaProvider(provider);
  const info = id ? mediaProviderInfo(id, kind) : null;
  if (!id || !info) return null;
  const path = providerDocPath(root, kind, id);
  if (!existsSync(path)) return null;
  const document = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const start = document.indexOf(`\n${PROVIDER_GUIDE_HEADING}\n`);
  if (start < 0) return null;
  const body = document.slice(start + PROVIDER_GUIDE_HEADING.length + 2);
  const end = body.search(/\n## /);
  const section = (end < 0 ? body : body.slice(0, end)).trim();
  return section ? `## Указания провайдера ${kind === 'video' ? 'видео' : 'изображений'}: ${info.title}\n\n${section}` : null;
}
