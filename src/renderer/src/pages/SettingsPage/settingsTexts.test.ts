/** Ожидания независимы от словаря: перенос сохраняет целые фразы и безопасный вывод внешних значений. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { settingsTexts } from '@shared/texts/settings';
import { AgentDiagnostics } from './components/AgentDiagnostics';

const sample = '«Тест» <script> & C:\\путь\\модель';

describe('тексты настроек', () => {
  it('сохраняет целые подписи диагностики и сообщений с внешними значениями', () => {
    expect(settingsTexts.defaultModel(sample)).toBe('«Тест» <script> & C:\\путь\\модель · по умолчанию');
    expect(settingsTexts.agentStatus(sample)).toBe('Агент: «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.executable(sample)).toBe('Файл: «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.version(sample)).toBe('Версия: «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.authorization(sample)).toBe('Авторизация: «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.agentMissing(sample)).toBe('«Тест» <script> & C:\\путь\\модель не найден на компьютере');
    expect(settingsTexts.accountLink(sample)).toBe('Личный кабинет «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.usageRestricted(sample)).toBe('«Тест» <script> & C:\\путь\\модель сообщает об ограничении использования.');
    expect(settingsTexts.accountUnavailable({ name: sample, missing: true })).toBe('Аккаунт не прочитан: «Тест» <script> & C:\\путь\\модель не найден.');
    expect(settingsTexts.accountUnavailable({ name: sample, missing: false })).toBe('Аккаунт не прочитан: «Тест» <script> & C:\\путь\\модель недоступен.');
    expect(settingsTexts.checkedAt(sample)).toBe('Проверено: «Тест» <script> & C:\\путь\\модель');
    expect(settingsTexts.limitExhausted('0%')).toBe('0% (Лимит исчерпан)');
    expect(settingsTexts.limitAlmostExhausted('1,5%')).toBe('1,5% (Лимит почти исчерпан)');
    expect(settingsTexts.limitRunningOut('21%')).toBe('21% (Лимит заканчивается)');
  });

  it.each([
    [0, '0 мин'],
    [1, '1 мин'],
    [2, '2 мин'],
    [5, '5 мин'],
    [11, '11 мин'],
    [21, '21 мин'],
    [-2, '-2 мин'],
    [1.5, '1.5 мин']
  ] as const)('сохраняет прежний формат окна %s минут', (value, expected) => {
    expect(settingsTexts.minutes(value)).toBe(expected);
  });

  it('экранирует путь и версию в диагностике, сохраняя подписи и отсутствие пустого пути', () => {
    const diagnostic = { provider: 'codex' as const, availability: 'available' as const, authorization: 'authenticated' as const, message: 'Готово' };
    const html = renderToStaticMarkup(createElement(AgentDiagnostics, { result: { ...diagnostic, executablePath: sample, version: sample } }));
    expect(html).toContain('Файл: «Тест» &lt;script&gt; &amp; C:\\путь\\модель');
    expect(html).toContain('Версия: «Тест» &lt;script&gt; &amp; C:\\путь\\модель');
    expect(html).toContain('Агент: Доступен');
    expect(html).toContain('Авторизация: Вход выполнен');
    expect(html).not.toContain('<script>');
    const empty = renderToStaticMarkup(createElement(AgentDiagnostics, { result: diagnostic }));
    expect(empty).not.toContain('Файл:');
    expect(empty).toContain('Версия: Не определена');
  });
});
