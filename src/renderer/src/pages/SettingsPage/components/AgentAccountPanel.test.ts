/** SSR проверяет контракт отображения без обращения к CLI или настоящим персональным данным. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAccountResult } from '@shared/agents';
import { AgentAccountPanel } from './AgentAccountPanel';

function account(overrides: Partial<AgentAccountResult> = {}): AgentAccountResult {
  return {
    provider: 'codex',
    checkedAt: '2026-10-25T12:00:00Z',
    diagnostic: { availability: 'available', authorization: 'unknown', message: 'Служебный вывод не показывать' },
    email: null,
    organization: null,
    authenticationMethod: null,
    plan: null,
    subscriptionStatus: null,
    subscriptionExpiresAt: null,
    limits: null,
    credits: null,
    ...overrides
  };
}

function render(result: AgentAccountResult | null, loading = false, failed = false): string {
  return renderToStaticMarkup(createElement(AgentAccountPanel, { result, loading, failed, disabled: false, onRefresh: vi.fn() }));
}

function fieldValue(html: string, label: string): string | undefined {
  // Удаляем только стили SSR, чтобы проверить семантическую пару названия и значения независимо от Emotion className.
  const markup = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<dt\\b[^>]*>${escapedLabel}</dt><dd\\b[^>]*>([^<]*)</dd>`).exec(markup)?.[1];
}

describe('сведения об аккаунте CLI', () => {
  it('подписывает каждое неизвестное поле и не угадывает аккаунт или тариф', () => {
    const html = render(account());
    for (const label of ['Вход', 'Аккаунт (email)', 'Организация', 'Способ входа', 'Тариф', 'Статус подписки', 'Срок подписки', 'Кредиты']) {
      expect(fieldValue(html, label), label).toBe('Не удалось уточнить');
    }
    expect(fieldValue(html, 'Лимит')).toBe('Не удалось уточнить');
    expect(html).not.toContain('Служебный вывод');
    expect(html).not.toContain('личный');
    expect(html).not.toContain('корпоративный');
    expect(html).not.toContain('color:#d32f2f');
  });

  it('показывает подтверждённые поля, нулевые кредиты и нулевое использование', () => {
    const html = render(
      account({
        diagnostic: { availability: 'available', authorization: 'authenticated', message: 'Проверка' },
        email: 'fixture@example.test',
        organization: 'Тестовая организация',
        authenticationMethod: 'chatgpt',
        plan: 'plus',
        subscriptionStatus: 'active',
        credits: '0',
        limits: [{ label: 'Основной', usedPercent: 0, windowMinutes: 0, resetsAt: 0 }]
      })
    );
    for (const text of ['fixture@example.test', 'Тестовая организация', '1970']) {
      expect(html).toContain(text);
    }
    for (const [label, value] of [
      ['Вход', 'Вход выполнен'],
      ['Способ входа', 'chatgpt'],
      ['Тариф', 'plus'],
      ['Статус подписки', 'active'],
      ['Кредиты', '0'],
      ['Лимит', 'Основной'],
      ['Использовано', '0%'],
      ['Осталось', '100%']
    ]) {
      expect(fieldValue(html, label), label).toBe(value);
    }
    expect(html).toContain('font-weight:600');
    expect(fieldValue(html, 'Окно')).toBe('0 мин');
    expect(html).not.toContain('color:#d32f2f');
  });

  it('не теряет исчерпанный лимит, а неизвестный сброс и окно подписывает явно', () => {
    const html = render(account({ limits: [{ label: 'Неделя', usedPercent: 100, windowMinutes: null, resetsAt: null }] }));
    expect(fieldValue(html, 'Лимит')).toBe('Неделя');
    expect(fieldValue(html, 'Использовано')).toBe('100%');
    expect(fieldValue(html, 'Осталось')).toBe('0% (Лимит исчерпан)');
    expect(html).toContain('color:#d32f2f');
    expect(fieldValue(html, 'Окно')).toBe('Не удалось уточнить');
    expect(fieldValue(html, 'Сброс')).toBe('Не удалось уточнить');
  });

  it('выравнивает все строки лимитов по той же сетке, что и поля аккаунта', () => {
    const html = render(account({ limits: [{ label: 'Основной', usedPercent: 22, windowMinutes: 300, resetsAt: null }] })).replace(
      /<style[^>]*>[\s\S]*?<\/style>/g,
      ''
    );
    const rowClass = (label: string): string | undefined => new RegExp(`<div class="([^"]+)"><dt\\b[^>]*>${label}</dt>`).exec(html)?.[1];
    const accountClass = rowClass('Вход');
    expect(accountClass).toBeDefined();
    for (const label of ['Лимит', 'Использовано', 'Осталось', 'Окно', 'Сброс']) {
      expect(rowClass(label), label).toBe(accountClass);
    }
    expect(fieldValue(html, 'Использовано')).toBe('22%');
    expect(fieldValue(html, 'Осталось')).toBe('78%');
  });

  it.each([
    [89.9, false],
    [90, true],
    [99, true]
  ] as const)('выделяет остаток до 10%% включительно при использовании %s%%', (usedPercent, red) => {
    const html = render(account({ limits: [{ label: 'Основной', usedPercent, windowMinutes: 300, resetsAt: null }] }));
    expect(html.includes('color:#d32f2f')).toBe(red);
    expect(fieldValue(html, 'Осталось')).not.toContain('Лимит исчерпан');
    if (usedPercent === 89.9) expect(fieldValue(html, 'Осталось')).toBe('10,1%');
  });

  it('при отсутствии CLI ограничивается статусом и кнопкой повторного чтения', () => {
    const html = render(account({ diagnostic: { availability: 'not_found', authorization: 'unknown', message: 'Служебный вывод' } }));
    expect(html).toContain('Аккаунт не прочитан: CLI не найден');
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Обновить<\/button>/);
    expect(html).not.toContain('Аккаунт (email):');
    expect(html).not.toContain('Служебный вывод');
  });

  it('при чтении не показывает прежний аккаунт и блокирует повторное чтение', () => {
    const html = render(account({ email: 'old@example.test' }), true);
    expect(html).toContain('Чтение аккаунта CLI');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Обновить<\/button>/);
    expect(html).not.toContain('old@example.test');
  });

  it('при ошибке чтения показывает ровно неизвестное значение', () => {
    expect(render(null, false, true)).toContain('Не удалось уточнить');
  });

  it('показывает нормализованное предупреждение приложения без служебной диагностики CLI', () => {
    const html = render(account({ message: 'CLI сообщает об ограничении использования.' }));
    expect(html).toMatch(/role="alert"[^>]*>/);
    expect(html).toContain('CLI сообщает об ограничении использования.');
    expect(html).not.toContain('Служебный вывод');
    expect(render(account({ message: 'Предупреждение прежнего аккаунта' }), true)).not.toContain('Предупреждение прежнего аккаунта');
  });

  it('красным выделяет подтверждённое отсутствие входа', () => {
    const html = render(account({ diagnostic: { availability: 'available', authorization: 'unauthenticated', message: 'Служебный вывод' } }));
    expect(fieldValue(html, 'Вход')).toBe('Вход не выполнен');
    expect(html).toContain('color:#d32f2f');
  });

  it('красным выделяет явный запрет использования и не выводит его из нулевого кредита или неизвестного статуса', () => {
    const blocked = render(account({ usageAllowed: false }));
    expect(blocked).toContain('CLI сообщает об ограничении использования.');
    expect(blocked).toContain('MuiAlert-standardError');
    for (const usageAllowed of [undefined, null, true]) {
      const html = render(account({ usageAllowed, credits: '0', subscriptionStatus: null }));
      expect(fieldValue(html, 'Кредиты')).toBe('0');
      expect(html).not.toContain('MuiAlert-standardError');
      expect(html).not.toContain('color:#d32f2f');
    }
  });
});
