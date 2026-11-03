/** SSR проверяет текст, ссылки и пустые слоты без запуска проверок среды или входа в провайдеры. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppState, EnvironmentCheck } from '@shared/types';
import { environmentTexts } from '@shared/texts/environment';
import { ApplicationResources } from './components/ApplicationResources';
import { EnvironmentCheckRow, type ProviderLogin } from './components/EnvironmentCheckRow';
import { EnvironmentDiagnostics } from './components/EnvironmentDiagnostics';

const sample = '«Тест» <script> & C:\\путь\\модель';
const check: EnvironmentCheck = { id: 'fixture', label: sample, ok: true, detail: 'Готово', hint: '', productionOnly: false, loginProvider: 'fixture' };
const text = (html: string): string => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');

function row(login: Partial<ProviderLogin> = {}, result: Partial<EnvironmentCheck> = {}): string {
  return renderToStaticMarkup(
    createElement(EnvironmentCheckRow, {
      check: { ...check, ...result },
      category: 'core',
      logins: { fixture: { status: 'authenticated', loggingIn: true, offline: false, onLogin: vi.fn(), ...login } }
    })
  );
}

describe('тексты среды', () => {
  it('сохраняет целые фразы диагностики и спецсимволы параметров', () => {
    expect(environmentTexts.authCheckFailed(sample)).toBe('Не удалось проверить вход: «Тест» <script> & C:\\путь\\модель');
    expect(environmentTexts.checksMissing(sample)).toBe('Проверка среды завершена. Не найдено: «Тест» <script> & C:\\путь\\модель.');
    expect(environmentTexts.checkFailed(sample)).toBe('Не удалось проверить среду: «Тест» <script> & C:\\путь\\модель');
    expect(environmentTexts.checkInterrupted(sample)).toBe(
      'Не удалось завершить проверку: «Тест» <script> & C:\\путь\\модель. Показаны последние доступные результаты.'
    );
    expect(environmentTexts.missingCore(sample)).toBe('Без этого приложение работает не полностью: «Тест» <script> & C:\\путь\\модель.');
    expect(environmentTexts.missingProduction(sample)).toBe(
      'Просмотр и редактирование работают. Не найдены локальные зависимости: «Тест» <script> & C:\\путь\\модель.'
    );
    expect(environmentTexts.checking(sample)).toBe('«Тест» <script> & C:\\путь\\модель: выполняется проверка');
    expect(environmentTexts.elapsed('1,5')).toBe('Время проверки: 1,5 с');
    expect(environmentTexts.checkElapsed('0,0')).toBe('· 0,0 с');
  });

  it('сохраняет условную ссылку входа, точный текст вокруг неё и экранирование URL', () => {
    const html = row({ authorizeUrl: 'https://example.test/login?a=1&b=%22', onCancel: vi.fn() });
    expect(html).toContain('href="https://example.test/login?a=1&amp;b=%22" target="_blank" rel="noreferrer"');
    expect(text(html)).toContain(
      'Страница входа открыта в браузере; приложение ждёт подтверждения до 5 минут. Если браузер не открылся, откройте страницу входа.'
    );
    expect(text(html)).toContain('Отменить вход');
    const withoutUrl = row();
    expect(text(withoutUrl)).toContain('Страница входа открыта в браузере; приложение ждёт подтверждения до 5 минут. ');
    expect(text(withoutUrl)).not.toContain('Если браузер');
    expect(withoutUrl).not.toContain('href=');
    expect(text(row({ loggingIn: false, authorizeUrl: 'https://example.test' }))).not.toContain('Страница входа открыта');
    expect(html).not.toContain('<script>');
    expect(html).toContain('«Тест» &lt;script&gt; &amp; C:\\путь\\модель');
  });

  it.each([
    { status: 'unauthenticated', loggingIn: false },
    { status: 'unknown', loggingIn: false, onCheck: vi.fn() },
    { status: 'authenticated', loggingIn: true, authorizeUrl: 'https://example.test/login', onCancel: vi.fn() }
  ] satisfies Partial<ProviderLogin>[])('не оборачивает блочные действия входа в абзац: $status', (login) => {
    const html = row(login);
    // Проверяем HTML после рендера MUI: JSX-фрагмент сам по себе не отменяет стандартный тег p.
    const secondary = html.match(/<(\w+)\b[^>]*class="[^"]*\bMuiListItemText-secondary\b[^"]*"/);
    expect(secondary?.[1]).toBe('div');
    expect(html).toContain('<button');
    if (login.authorizeUrl) {
      expect(html).toContain('href="https://example.test/login"');
      expect(text(html)).toContain('Отменить вход');
    }
  });

  it.each([
    ['checking', 'Проверка входа'],
    ['authenticated', 'Сменить аккаунт'],
    ['unauthenticated', 'Войти'],
    ['unknown', 'Проверить вход']
  ] as const)('сохраняет подпись действия статуса %s', (status, label) => {
    expect(text(row({ status, loggingIn: false, onCheck: vi.fn() }))).toContain(label);
  });

  it('показывает проверяемую строку и её время с прежним форматом', () => {
    expect(row({}, { status: 'running' })).toContain('aria-label="«Тест» &lt;script&gt; &amp; C:\\путь\\модель: выполняется проверка"');
    expect(text(row({}, { elapsedMs: 1500 }))).toContain('· 1,5 с');
    expect(text(row({}, { elapsedMs: 0 }))).toContain('· 0,0 с');
  });

  it('оставляет отсутствующий локальный путь пустым, а заданный безопасно выводит', () => {
    const props = { onChooseToolsRoot: vi.fn(), onResetToolsRoot: vi.fn() };
    const empty = text(renderToStaticMarkup(createElement(ApplicationResources, { ...props, state: null })));
    expect(empty).toContain('Определяем ресурсы…Локальное состояние (текущий проект, история): ');
    expect(empty).not.toContain('undefined');
    expect(empty).not.toContain('{path}');
    const html = renderToStaticMarkup(
      createElement(ApplicationResources, { ...props, state: { localDir: sample, toolsRoot: sample, packaged: true } as AppState })
    );
    expect(text(html)).toContain('Локальное состояние (текущий проект, история): «Тест» &lt;script&gt; &amp; C:\\путь\\модель');
    expect(html).not.toContain('<script>');
  });

  it('экранирует ошибки и списки зависимостей без потери диагностических фраз', () => {
    const html = renderToStaticMarkup(createElement(EnvironmentDiagnostics, { checks: [{ ...check, ok: false }], loading: false, error: sample }));
    expect(text(html)).toContain('Не удалось завершить проверку: «Тест» &lt;script&gt; &amp; C:\\путь\\модель. Показаны последние доступные результаты.');
    expect(text(html)).toContain('Без этого приложение работает не полностью: «Тест» &lt;script&gt; &amp; C:\\путь\\модель.');
    expect(html).not.toContain('<script>');
  });
});
