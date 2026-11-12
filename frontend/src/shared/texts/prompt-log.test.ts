import { describe, expect, it } from 'vitest';
import { promptLogTexts } from './prompt-log';

describe('Заголовки журнала отправок', () => {
  it('служебные имена заданий агента показывает словами страницы', () => {
    expect(promptLogTexts.title('ai-clip-scene:M02.1:prompt')).toBe('M02.1 · Видеопромпт');
    expect(promptLogTexts.title('ai-clip-scenario:revise')).toBe('Сценарий · доработка');
    expect(promptLogTexts.title('ai-clip-scene:M03:неизвестно')).toBe('ai-clip-scene:M03:неизвестно');
    expect(promptLogTexts.title('Проверка видео агентом')).toBe('Проверка видео агентом');
  });
});
