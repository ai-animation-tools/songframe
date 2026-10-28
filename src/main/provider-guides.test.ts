/** Каждый провайдер реестра описан своим документом, и агент получает только раздел выбранного провайдера. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MEDIA_PROVIDERS, MEDIA_PROVIDER_IDS, registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { PROVIDER_GUIDE_HEADING, providerDocPath, providerGuide } from './provider-guides';

const root = resolve(__dirname, '../..');
let temporary: string | null = null;
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = null;
});

it.each(MEDIA_PROVIDER_IDS.flatMap((id) => MEDIA_PROVIDERS[id].kinds.map((kind) => [id, kind] as const)))(
  'у провайдера %s есть документ вида %s с указаниями агенту',
  (id, kind) => {
    expect(readFileSync(providerDocPath(root, kind, id), 'utf8')).toContain(`\n${PROVIDER_GUIDE_HEADING}\n`);
    const guide = providerGuide(root, kind, id);
    expect(guide).toMatch(new RegExp(`^## Указания провайдера (видео|изображений): ${MEDIA_PROVIDERS[id].title}\\n\\n\\S`));
  }
);

it('передаёт только раздел указаний и не путает виды медиа и регистр имени', () => {
  temporary = mkdtempSync(join(tmpdir(), 'songframe-guides-'));
  mkdirSync(join(temporary, 'docs/providers/video'), { recursive: true });
  // Тестовый провайдер регистрируется только здесь: у него нет документа в настоящем комплексе.
  const restoreProvider = registerMediaProviderForTests(TEST_PROVIDER, { ...testProviderInfo, title: 'Test' });
  writeFileSync(
    join(temporary, `docs/providers/video/${TEST_PROVIDER}.md`),
    '# Сервис\r\n\r\nДля людей.\r\n\r\n## Указания агенту\r\n\r\n- слот audio_1\r\n\r\n## Ещё\r\n\r\nНе для агента.\r\n'
  );
  try {
    const guide = providerGuide(temporary, 'video', ' Test ');
    expect(guide).toBe(`## Указания провайдера видео: ${MEDIA_PROVIDERS[TEST_PROVIDER].title}\n\n- слот audio_1`);
    expect(providerGuide(temporary, 'image', TEST_PROVIDER)).toBeNull();
    expect(providerGuide(temporary, 'video', 'codex')).toBeNull();
    expect(providerGuide(temporary, 'video', null)).toBeNull();
  } finally {
    restoreProvider();
  }
});
