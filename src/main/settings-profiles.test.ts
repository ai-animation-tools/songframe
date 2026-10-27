/** Личные настройки CLI сохраняются независимо: создание опор не должно переносить модель Claude в Codex. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings';

let directory: string;
let store: SettingsStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'songframe-profiles-'));
  store = new SettingsStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const claude = { provider: 'claude' as const, executablePath: '/fixture/claude cli', model: 'claude-personal' };
const codex = { provider: 'codex' as const, executablePath: '/fixture/codex cli', model: 'codex-personal' };

function saveRaw(value: unknown): void {
  writeFileSync(join(directory, 'settings.json'), JSON.stringify(value));
}
function raw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
}

describe('независимые профили Claude и Codex', () => {
  it('читает legacy agent без подстановки его пути и модели другому провайдеру', () => {
    saveRaw({ agent: claude, toolsRootOverride: '/fixture/tools', custom: { nested: ['сохранить'] } });
    const before = readFileSync(join(directory, 'settings.json'), 'utf8');
    expect(store.getAgent()).toEqual(claude);
    expect(store.getProviderAgent('claude')).toEqual(claude);
    expect(store.getProviderAgent('codex')).toBeNull();
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before);
  });

  it('сохраняет второй профиль, не меняя выбранного исполнителя и неизвестных полей legacy файла', () => {
    saveRaw({ agent: claude, toolsRootOverride: '/fixture/tools', custom: { nested: ['сохранить'] }, featureFromFuture: true });
    store.saveProviderAgent(codex);
    expect(store.getAgent()).toEqual(claude);
    expect(store.getProviderAgent('claude')).toEqual(claude);
    expect(store.getProviderAgent('codex')).toEqual(codex);
    expect(raw()).toMatchObject({ toolsRootOverride: '/fixture/tools', custom: { nested: ['сохранить'] }, featureFromFuture: true });
    const reopened = new SettingsStore(directory);
    expect(reopened.getAgent()).toEqual(claude);
    expect(reopened.getProviderAgent('codex')).toEqual(codex);
  });

  it('смена глобального выбора и очистка выбора оставляют оба личных профиля', () => {
    store.saveAgent(claude);
    store.saveAgent(codex);
    expect(store.getAgent()).toEqual(codex);
    expect(store.getProviderAgent('claude')).toEqual(claude);
    expect(store.getProviderAgent('codex')).toEqual(codex);
    store.saveAgent(null);
    expect(store.getAgent()).toBeNull();
    expect(store.getProviderAgent('claude')).toEqual(claude);
    expect(store.getProviderAgent('codex')).toEqual(codex);
  });

  it('правка выбранного профиля обновляет legacy agent, не затрагивая второй профиль', () => {
    store.saveAgent(claude);
    store.saveProviderAgent(codex);
    const changed = { ...claude, model: 'другая модель Claude' };
    store.saveProviderAgent(changed);
    expect(store.getAgent()).toEqual(changed);
    expect(raw()).toMatchObject({ agentProfiles: { claude: changed, codex } });
  });

  it('не выбирает агента неявно при сохранении единственного профиля', () => {
    store.saveProviderAgent(codex);
    expect(store.getAgent()).toBeNull();
    expect(store.getProviderAgent('codex')).toEqual(codex);
    expect(store.getProviderAgent('claude')).toBeNull();
  });

  it('сохраняет отдельные модели текстового Codex и Codex изображений, включая перезапуск', () => {
    const image = { ...codex, executablePath: '/fixture/image codex', model: 'codex-image-personal' };
    store.saveAgent(codex);
    store.saveImageAgent(image);
    expect(store.getAgent()).toEqual(codex);
    expect(store.getProviderAgent('codex')).toEqual(codex);
    expect(store.getImageAgent()).toEqual(image);
    store.saveAgent({ ...codex, model: 'обновлённая текстовая модель' });
    expect(store.getImageAgent()).toEqual(image);
    const reopened = new SettingsStore(directory);
    expect(reopened.getAgent()?.model).toBe('обновлённая текстовая модель');
    expect(reopened.getImageAgent()).toEqual(image);
  });

  it('отклоняет Claude как профиль изображений, не портя настройки и исходный файл', () => {
    store.saveAgent(codex);
    const before = readFileSync(join(directory, 'settings.json'), 'utf8');
    expect(() => store.saveImageAgent(claude)).toThrow(/Codex/);
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before);
    saveRaw({ agent: codex, imageAgent: claude, custom: 'сохранить' });
    const malformed = readFileSync(join(directory, 'settings.json'), 'utf8');
    expect(() => store.getImageAgent()).toThrow(/Неверный формат агента/);
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(malformed);
  });

  it('использует legacy профиль Codex для изображений только пока отдельный профиль ещё не задан', () => {
    expect(store.getImageAgent()).toEqual({ provider: 'codex' });
    store.saveAgent(claude);
    expect(store.getImageAgent()).toEqual({ provider: 'codex' });
    store.saveProviderAgent(codex);
    expect(store.getImageAgent()).toEqual(codex);
    store.saveImageAgent({ ...codex, model: 'отдельная модель изображений' });
    expect(store.getImageAgent().model).toBe('отдельная модель изображений');
    expect(store.getAgent()).toEqual(claude);
  });

  it.each([{ codex: claude }, { claude: codex }, { unknown: codex }, { codex: null }, []])(
    'отклоняет ошибочный словарь профилей и сохраняет исходный файл: %j',
    (agentProfiles) => {
      saveRaw({ agent: claude, agentProfiles, custom: 'сохранить' });
      const before = readFileSync(join(directory, 'settings.json'), 'utf8');
      expect(() => store.read()).toThrow(/Неверный формат агента/);
      expect(() => store.saveProviderAgent(codex)).toThrow();
      expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before);
    }
  );
});
