/** Полные фразы проверяются независимо от словаря; ошибки не должны портить настройки на диске. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsTexts } from '@shared/texts/settings';
import { normalizeAgentSettings, SettingsStore } from './settings';

let directory: string;
let store: SettingsStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'Настройки «агента» & '));
  store = new SettingsStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('Полные сообщения настроек и аккаунта', () => {
  it.each([
    [[], 'Неверный формат настроек агента.'],
    [{ provider: 'missing' }, 'Выберите Claude Code или Codex.'],
    [{ provider: 'claude', model: null }, 'Модель должна быть текстом без нулевых символов.'],
    [{ provider: 'codex', model: 'до\0после' }, 'Модель должна быть текстом без нулевых символов.']
  ])('сохраняет исходный файл после отказа в профиле %j', (input, expected) => {
    const file = join(directory, 'settings.json');
    const before = JSON.stringify({ agent: { provider: 'codex', model: 'текст «&»' }, custom: ['оставить'] });
    writeFileSync(file, before);
    expect(() => normalizeAgentSettings(input)).toThrowError(new Error(expected));
    expect(() => store.saveAgent(input)).toThrowError(new Error(expected));
    expect(() => store.saveProviderAgent(input)).toThrowError(new Error(expected));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([[], { toolsRootOverride: 42 }])('передаёт путь целиком в ошибке формата настроек: %j', (value) => {
    const file = join(directory, 'settings.json');
    const before = JSON.stringify(value);
    writeFileSync(file, before);
    const expected = `Неверный формат ${file}. Настройки сохранены; исправьте файл или перенесите его в резервную папку.`;
    expect(() => store.read()).toThrowError(new Error(expected));
    expect(() => store.saveAgent({ provider: 'codex' })).toThrowError(new Error(expected));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    { agent: [] },
    { agentProfiles: [] },
    { agentProfiles: { unknown: { provider: 'codex' } } },
    { agentProfiles: { claude: { provider: 'codex' } } },
    { agentProfiles: { codex: null } }
  ])('передаёт путь целиком и не заменяет повреждённый профиль: %j', (value) => {
    const file = join(directory, 'settings.json');
    const before = JSON.stringify(value);
    writeFileSync(file, before);
    const expected = `Неверный формат агента в ${file}. Настройки сохранены; исправьте файл или перенесите его в резервную папку.`;
    expect(() => store.read()).toThrowError(new Error(expected));
    expect(() => store.saveProviderAgent({ provider: 'codex' })).toThrowError(new Error(expected));
    expect(() => store.write({ toolsRootOverride: null })).toThrowError(new Error(expected));
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('сохраняет полные причины отсутствующего профиля и неподходящего исполнителя', () => {
    expect(() => store.saveProviderAgent(null)).toThrowError(new Error('Укажите профиль агента.'));
    expect(() => store.getImageAgent('unknown')).toThrowError(new Error('Выбранный провайдер изображений не исполняется программой-агентом.'));
    expect(normalizeAgentSettings(undefined)).toBeNull();
    expect(normalizeAgentSettings(null)).toBeNull();
  });

  // Значения и пунктуация сохраняются дословно: перенос не исправляет грамматику и не валидирует данные CLI повторно.
  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2'],
    [5, '5'],
    [11, '11'],
    [21, '21'],
    [-1, '-1'],
    [1.5, '1.5']
  ])('сохраняет минуты и разделители в подписи окна %s', (value, expected) => {
    expect(settingsTexts.main.limitWithWindow({ name: 'имя «&»', windowMinutes: value })).toBe(`имя «&» · ${expected} мин`);
    expect(settingsTexts.main.limitLabel({ name: 'имя «&»', kind: 'primary', windowMinutes: value })).toBe(`имя «&» · primary · ${expected} мин`);
  });

  it('не добавляет окно или лишний разделитель для неизвестной длительности', () => {
    expect(settingsTexts.main.limitLabel({ name: 'имя «&»', kind: 'secondary', windowMinutes: null })).toBe('имя «&» · secondary');
  });
});
