import { describe, expect, it } from 'vitest';
import type { MediaCapabilities } from '@shared/media-providers';
import { capabilitiesFailed, capabilitiesNote, capabilitiesSummary } from './capabilitiesSummary';

const model = (id: string, command: string) => ({ id, command, arguments: {}, slots: {}, limits: {} });
const kling = (overrides: Partial<MediaCapabilities> = {}): MediaCapabilities => ({
  provider: 'kling',
  kind: 'video',
  available: true,
  checkedAt: '2026-10-28T08:18:11.808Z',
  models: [model('kling-video-v2_6', 'text_to_video'), model('kling-video-v2_6', 'image_to_video'), model('kling-video-v3_0', 'text_to_video')],
  problems: [],
  generationVerified: false,
  ...overrides
});

describe('итог проверки возможностей', () => {
  it('называет провайдера и число моделей без технических имён', () => {
    const text = capabilitiesSummary(kling());
    expect(text).toBe('Kling доступен. Моделей для выбора: 2.');
    expect(text).not.toContain('kling-video');
    expect(capabilitiesNote(kling())).toContain('не тратит кредиты');
  });

  it('объясняет недоступность и неполный ответ', () => {
    expect(capabilitiesSummary(kling({ available: false }))).toBe('Kling сейчас недоступен.');
    expect(capabilitiesSummary(kling({ problems: ['text_to_video: таймаут'] }))).toContain('Повторить проверку');
  });

  it('предлагает повтор только после ошибки, недоступности или неполного ответа', () => {
    expect(capabilitiesFailed(null, null)).toBe(false);
    expect(capabilitiesFailed(kling(), null)).toBe(false);
    expect(capabilitiesFailed(null, 'сеть недоступна')).toBe(true);
    expect(capabilitiesFailed(kling({ available: false }), null)).toBe(true);
    expect(capabilitiesFailed(kling({ problems: ['таймаут'] }), null)).toBe(true);
  });
});
