/** Замечание сопровождает только возврат: остальные ответы доступны без заполнения поля. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PackageDecision } from './PackageDecision';

vi.mock('../../../state', () => ({
  useApp: () => ({
    aiAccess: {
      agent: { selected: true, available: true, provider: 'codex', message: '' },
      image: { selected: true, available: true, provider: 'kling', message: '' },
      video: { selected: true, available: true, provider: 'kling', message: '' }
    }
  })
}));

function render(overrides: Partial<Parameters<typeof PackageDecision>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PackageDecision, {
      pending: { stage: 'request_choice', question: 'Что сделать с запросом?', options: ['send', 'park', 'revise'] },
      aiKind: 'video',
      note: '',
      setNote: vi.fn(),
      busy: false,
      onDecide: vi.fn(),
      ...overrides
    })
  );
}

function button(html: string, label: string): string {
  const match = html.match(new RegExp(`<button\\b[^>]*>(?:(?!<\\/button>)[\\s\\S])*?${label}<\\/button>`));
  expect(match, `Кнопка «${label}» должна оставаться видимой`).not.toBeNull();
  return match![0];
}

describe('Замечание при согласовании пакета', () => {
  it('показывает многострочное поле с доступными подписью и пояснением', () => {
    const html = render();
    const fieldId = html.match(/<label[^>]*for="([^"]+)"[^>]*>Что нужно исправить<\/label>/)?.[1];
    expect(fieldId).toBeTruthy();
    const textarea = html.match(new RegExp(`<textarea[^>]*id="${fieldId}"[^>]*>`))?.[0];
    expect(textarea).toBeTruthy();
    expect(textarea).toContain(`aria-describedby="${fieldId}-helper-text"`);
    expect(html).toContain(`id="${fieldId}-helper-text"`);
    expect(html).toContain('Обязательно только для «Вернуть с замечанием»');
    expect(html).toContain('Замечание сохранится вместе с ответом. Агент автоматически не запускается.');
    expect(html).toContain('После возврата нажмите «Запустить доработку с агентом» в блоке «Подготовка плана».');
    expect(textarea).toContain('заменить последнюю опору');
  });

  it.each(['', ' \n\t '])('при пустом замечании %j блокирует возврат и сохраняет другие ответы', (note) => {
    const html = render({ note });
    expect(button(html, 'Вернуть с замечанием')).toContain('disabled=""');
    expect(button(html, 'Отправить')).not.toContain('disabled=""');
    expect(button(html, 'Сохранить в очередь')).not.toContain('disabled=""');
  });

  it('разрешает возврат с замечанием и сохраняет многострочный текст', () => {
    const note = 'Уточнить действие героя.\nСохранить направление движения камеры.';
    const html = render({ note });
    expect(button(html, 'Вернуть с замечанием')).not.toContain('disabled=""');
    expect(html).toContain(note);
  });

  it('во время операции блокирует все ответы, сохраняя замечание', () => {
    const html = render({ busy: true, note: 'Сохранить одежду героя.' });
    for (const label of ['Отправить', 'Сохранить в очередь', 'Вернуть с замечанием']) {
      expect(button(html, label)).toContain('disabled=""');
    }
    expect(html).toContain('Сохранить одежду героя.');
  });

  it('подбирает пример замечания к этапу', () => {
    const html = render({
      pending: { stage: 'prompt_review', question: 'Принять промпт?', options: ['approve', 'revise'] }
    });
    expect(html).not.toContain('внешн');
    expect(html).toContain('камера медленно приближается к герою');
    expect(button(html, 'Принять')).not.toContain('disabled=""');
  });

  it('не просит замечание, если возврата нет среди ответов', () => {
    const html = render({ pending: { stage: 'downloaded', question: 'Принять результат?', options: ['accept', 'retry'] } });
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Что нужно исправить');
    expect(button(html, 'Принять')).not.toContain('disabled=""');
    expect(button(html, 'Повторить запрос')).not.toContain('disabled=""');
  });

  it('объясняет последствия каждого ответа списком под вопросом', () => {
    const html = render({ pending: { stage: 'downloaded', question: 'Принять результат?', options: ['accept', 'retry', 'review', 'revise'] } });
    expect(html).toContain('Готовит новую попытку с теми же опорами и промптом');
    expect(html).toContain('Открывает «Монтаж пробы» с соседними планами');
    expect(html).toContain('Переносит результат в assets');
    expect(button(html, 'Повторить запрос')).toContain('title="Готовит новую попытку');
  });
});
