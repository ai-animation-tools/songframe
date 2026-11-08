/** Замечание сопровождает только возврат: остальные ответы доступны без заполнения поля. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PackageDecision } from './PackageDecision';

vi.mock('../../../state', () => ({
  useApp: () => ({
    aiAccess: {
      agent: { selected: true, available: true, provider: 'codex', message: '' },
      image: { selected: true, available: true, provider: 'test', message: '' },
      video: { selected: true, available: true, provider: 'test', message: '' }
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
  it('без замечания прячет поле: его открывает «Доработать»', () => {
    const html = render();
    expect(html).not.toContain('<textarea');
    expect(button(html, 'Доработать')).not.toContain('disabled=""');
    expect(button(html, 'Отправить')).not.toContain('disabled=""');
  });

  it('показывает многострочное поле с доступными подписью и пояснением', () => {
    const html = render({ note: 'Заменить свет' });
    const fieldId = html.match(/<label[^>]*for="([^"]+)"[^>]*>Что нужно исправить<\/label>/)?.[1];
    expect(fieldId).toBeTruthy();
    const textarea = html.match(new RegExp(`<textarea[^>]*id="${fieldId}"[^>]*>`))?.[0];
    expect(textarea).toBeTruthy();
    expect(textarea).toContain(`aria-describedby="${fieldId}-helper-text"`);
    expect(html).toContain(`id="${fieldId}-helper-text"`);
    expect(html).toContain('агент начнёт доработку сразу после нажатия кнопки');
    expect(textarea).toContain('заменить последнюю опору');
  });

  it('разрешает возврат с замечанием и сохраняет многострочный текст', () => {
    const note = 'Уточнить действие героя.\nСохранить направление движения камеры.';
    const html = render({ note });
    expect(button(html, 'Доработать')).not.toContain('disabled=""');
    expect(html).toContain(note);
  });

  it('во время операции блокирует все ответы, сохраняя замечание', () => {
    const html = render({ busy: true, note: 'Сохранить одежду героя.' });
    for (const label of ['Отправить', 'Сохранить в очередь', 'Доработать']) {
      expect(button(html, label)).toContain('disabled=""');
    }
    expect(html).toContain('Сохранить одежду героя.');
  });

  it('подбирает пример замечания к этапу', () => {
    const html = render({
      note: 'Заменить свет',
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
    expect(button(html, 'Новая генерация')).not.toContain('disabled=""');
  });

  it('объясняет последствия каждого ответа подсказкой кнопки', () => {
    const html = render({ pending: { stage: 'downloaded', question: 'Принять результат?', options: ['accept', 'retry', 'review', 'revise'] } });
    expect(button(html, 'Собрать пробу стыков')).toContain('Открывает «Монтаж пробы» с соседними планами');
    expect(button(html, 'Принять')).toContain('Переносит результат в assets');
    expect(button(html, 'Новая генерация')).toContain('title="Готовит новую попытку');
  });

  it('для вопроса об опоре показывает её код, обязательное замечание и охват «для следующих» по умолчанию', () => {
    const empty = render({ pending: { stage: 'keyframes_review', question: 'Утвердить опору K02?', options: ['approve', 'revise'], frame: 'K02' } });
    expect(button(empty, 'Доработать K02')).not.toContain('disabled=""');
    const html = render({
      note: 'Сохранить одежду',
      pending: { stage: 'keyframes_review', question: 'Утвердить опору K02?', options: ['approve', 'revise'], frame: 'K02' }
    });
    expect(html).toContain('Опора K02');
    expect(html).toContain('Что исправить в опоре K02');
    expect(html).toContain('Учесть и для следующих опор');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(button(html, 'Утвердить K02')).not.toContain('disabled=""');
    expect(html).not.toContain('Запустить доработку с агентом');
  });
});
