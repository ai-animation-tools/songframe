import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_PROVIDERS, registerMediaProviderForTests, type MediaCapabilities } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { capabilitiesFailed, capabilitiesNote, capabilitiesSummary } from './capabilitiesSummary';

const model = (id: string, command: string) => ({ id, command, arguments: {}, slots: {}, limits: {} });
let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
});
afterAll(() => restoreProvider());

const paid = (overrides: Partial<MediaCapabilities> = {}): MediaCapabilities => ({
  provider: TEST_PROVIDER,
  kind: 'video',
  available: true,
  checkedAt: '2026-10-28T08:18:11.808Z',
  models: [model('test-video', 'text_to_video'), model('test-video', 'image_to_video'), model('test-video-pro', 'text_to_video')],
  problems: [],
  generationVerified: false,
  ...overrides
});

describe('итог проверки возможностей', () => {
  it('называет провайдера и число моделей без технических имён', () => {
    const text = capabilitiesSummary(paid());
    expect(text).toBe(`${MEDIA_PROVIDERS[TEST_PROVIDER].title} доступен. Моделей для выбора: 2.`);
    expect(text).not.toContain('test-video');
    expect(capabilitiesNote(paid())).toBe(MEDIA_PROVIDERS[TEST_PROVIDER].capabilitiesNote);
  });

  it('объясняет недоступность и неполный ответ', () => {
    expect(capabilitiesSummary(paid({ available: false }))).toBe(`${MEDIA_PROVIDERS[TEST_PROVIDER].title} сейчас недоступен.`);
    expect(capabilitiesSummary(paid({ problems: ['text_to_video: таймаут'] }))).toContain('Повторить проверку');
  });

  it('предлагает повтор только после ошибки, недоступности или неполного ответа', () => {
    expect(capabilitiesFailed(null, null)).toBe(false);
    expect(capabilitiesFailed(paid(), null)).toBe(false);
    expect(capabilitiesFailed(null, 'сеть недоступна')).toBe(true);
    expect(capabilitiesFailed(paid({ available: false }), null)).toBe(true);
    expect(capabilitiesFailed(paid({ problems: ['таймаут'] }), null)).toBe(true);
  });
});
