import { describe, expect, it } from 'vitest';
import { aiActionProblem, type AiAccess } from './ai-access';

const ready: AiAccess = {
  agent: { provider: 'claude', selected: true, available: true, message: '' },
  image: { provider: 'codex', selected: true, available: true, message: '' },
  video: { provider: 'kling', selected: true, available: true, message: '' }
};

describe('причина блокировки ИИ', () => {
  it('блокирует любые действия до проверки и при выключенном агенте даже с готовым медиапрофилем', () => {
    expect(aiActionProblem(null, 'image')).toContain('Проверяем');
    const access: AiAccess = { ...ready, agent: { provider: null, selected: false, available: false, message: 'Выберите агента.' } };
    for (const kind of ['agent', 'image', 'video'] as const) expect(aiActionProblem(access, kind)).toBe('Выберите агента.');
  });

  it('не считает default provider выбором и не считает сохранённый ID доступным CLI', () => {
    expect(aiActionProblem({ ...ready, image: { ...ready.image, selected: false, message: 'Выберите провайдера изображений.' } }, 'image')).toBe(
      'Выберите провайдера изображений.'
    );
    expect(aiActionProblem({ ...ready, image: { ...ready.image, available: false, message: 'Codex CLI не найден.' } }, 'image')).toBe('Codex CLI не найден.');
    expect(aiActionProblem(ready, 'image')).toBeNull();
  });
});
