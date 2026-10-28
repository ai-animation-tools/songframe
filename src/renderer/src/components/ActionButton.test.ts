/** Выключенная по условию кнопка объясняет причину в подсказке, кнопка-иконка всегда называет назначение. */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionButton } from './ActionButton';
import { ActionIconButton } from './ActionIconButton';
import { buttonHint } from './buttonHint';

// Emotion выводит стили перед разметкой; для проверки структуры они не нужны.
const render = (element: ReactElement): string => renderToStaticMarkup(element).replace(/<style[^>]*>.*?<\/style>/g, '');
const disabled = (html: string): boolean => /<button[^>]*disabled=""/.test(html);

describe('ActionButton', () => {
  it('показывает назначение и причину в подсказке выключенной кнопки и делает обёртку фокусируемой', () => {
    const html = render(
      createElement(ActionButton, { title: 'Сохранить сценарий.', disabled: true, disabledReason: 'Нет изменений для сохранения.' }, 'Сохранить')
    );
    expect(disabled(html)).toBe(true);
    expect(html).toContain('title="Сохранить сценарий. Недоступно: Нет изменений для сохранения."');
    expect(html).toMatch(/^<span[^>]*tabindex="0"/);
    expect(html).toMatch(/^<span[^>]*aria-label="Сохранить сценарий. Недоступно: Нет изменений для сохранения."/);
  });

  it('без назначения показывает только причину', () => {
    const html = render(createElement(ActionButton, { disabled: true, disabledReason: 'Сначала выберите план.' }, 'Открыть'));
    expect(html).toContain('title="Сначала выберите план."');
    expect(html).toMatch(/^<span/);
  });

  it('у доступной кнопки не показывает причину и не добавляет обёртку', () => {
    const html = render(createElement(ActionButton, { title: 'Сохранить', disabledReason: 'Нет изменений для сохранения.' }, 'Сохранить'));
    expect(disabled(html)).toBe(false);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('title="Сохранить"');
    expect(html).not.toContain('Недоступно');
  });

  it('выключенная кнопка без причины остаётся без обёртки', () => {
    const html = render(createElement(ActionButton, { disabled: true }, 'Сохранить'));
    expect(disabled(html)).toBe(true);
    expect(html).toMatch(/^<button/);
  });
});

describe('ActionIconButton', () => {
  it('сохраняет доступное имя доступной кнопки', () => {
    const html = render(createElement(ActionIconButton, { 'aria-label': 'Удалить кадр' }, 'x'));
    expect(html).toMatch(/^<button[^>]*aria-label="Удалить кадр"/);
    expect(disabled(html)).toBe(false);
  });

  it('у выключенной кнопки показывает назначение и причину, не меняя доступного имени кнопки', () => {
    const html = render(
      createElement(ActionIconButton, { 'aria-label': 'Удалить кадр', disabled: true, disabledReason: 'Дождитесь завершения текущей операции.' }, 'x')
    );
    expect(disabled(html)).toBe(true);
    expect(html).toMatch(/^<span[^>]*tabindex="0"/);
    expect(html).toContain('aria-label="Удалить кадр. Недоступно: Дождитесь завершения текущей операции."');
    expect(html).toMatch(/<button[^>]*aria-label="Удалить кадр"/);
  });

  it('выключенная без причины кнопка всё равно называет назначение, но не берёт фокус', () => {
    const html = render(createElement(ActionIconButton, { 'aria-label': 'Вперёд', title: 'Следующий план', disabled: true }, 'x'));
    expect(html).toMatch(/^<span[^>]*aria-label="Следующий план"/);
    expect(html).not.toContain('tabindex="0"');
  });
});

it('buttonHint объединяет назначение и причину', () => {
  expect(buttonHint('Сохранить.', 'Нет изменений.')).toBe('Сохранить. Недоступно: Нет изменений.');
  expect(buttonHint(undefined, 'Нет изменений.')).toBe('Нет изменений.');
  expect(buttonHint('Сохранить', null)).toBe('Сохранить');
});
