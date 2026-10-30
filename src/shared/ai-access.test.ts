import { describe, expect, it } from 'vitest';
import { aiActionProblem, type AiAccess } from './ai-access';

const ready: AiAccess = {
  agent: { provider: 'claude', selected: true, available: true, message: '' },
  image: { provider: 'codex', selected: true, available: true, message: '' },
  video: { provider: 'test', selected: true, available: true, message: '' }
};

describe('причина блокировки ИИ', () => {
  it('до проверки блокирует всё, а без агента — только текстовые этапы', () => {
    expect(aiActionProblem(null, 'image')).toContain('Проверяем');
    const access: AiAccess = { ...ready, agent: { provider: null, selected: false, available: false, message: 'Выберите агента.' } };
    expect(aiActionProblem(access, 'agent')).toBe('Выберите агента.');
    // Провайдеры медиа не зависят от выбранного агента.
    expect(aiActionProblem(access, 'image')).toBeNull();
    expect(aiActionProblem(access, 'video')).toBeNull();
  });

  it('не считает default provider выбором и не считает сохранённый ID доступным CLI', () => {
    expect(aiActionProblem({ ...ready, image: { ...ready.image, selected: false, message: 'Выберите провайдера изображений.' } }, 'image')).toBe(
      'Выберите провайдера изображений.'
    );
    expect(aiActionProblem({ ...ready, image: { ...ready.image, available: false, message: 'Codex не найден.' } }, 'image')).toBe('Codex не найден.');
    expect(aiActionProblem(ready, 'image')).toBeNull();
  });
});

it('сохраняет полные резервные сообщения до проверки и для каждого вида исполнителя', () => {
  expect(aiActionProblem(undefined)).toBe('Проверяем выбор и доступность исполнителей ИИ…');
  expect(aiActionProblem({ ...ready, agent: { ...ready.agent, available: false } })).toBe('Сначала выберите доступного агента в настройках приложения.');
  expect(aiActionProblem({ ...ready, image: { ...ready.image, selected: false } }, 'image')).toBe(
    'Сначала выберите доступного провайдера изображений в настройках проекта.'
  );
  expect(aiActionProblem({ ...ready, video: { ...ready.video, available: false } }, 'video')).toBe(
    'Сначала выберите доступного провайдера видео в настройках проекта.'
  );
});
