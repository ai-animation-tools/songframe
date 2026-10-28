/** Личные настройки CLI сохраняются независимо: создание опор не должно переносить модель Claude в Codex. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings';
import { registerTestAgentProvider, registerTestMediaProvider, TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo } from './testing/media-provider';

let restoreProviders: () => void;
beforeAll(() => {
  const restorePaid = registerTestMediaProvider();
  const restoreAgent = registerTestAgentProvider();
  restoreProviders = () => {
    restoreAgent();
    restorePaid();
  };
});
afterAll(() => restoreProviders());

let directory: string;
let store: SettingsStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'songframe-profiles-'));
  store = new SettingsStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const claude = { provider: 'claude' as const, model: 'claude-personal' };
const codex = { provider: 'codex' as const, model: 'codex-personal' };

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

  it('отбрасывает лишние поля профиля, включая прежний путь CLI, при чтении и сохранении', () => {
    saveRaw({ agent: { ...claude, executablePath: '/fixture/claude cli' }, agentProfiles: { codex: { ...codex, executablePath: '/fixture/codex cli' } } });
    expect(store.getAgent()).toEqual(claude);
    expect(store.getProviderAgent('codex')).toEqual(codex);
    expect(store.saveProviderAgent({ ...codex, executablePath: '/fixture/другой codex' })).toEqual(codex);
    expect(raw()).toMatchObject({ agent: claude, agentProfiles: { codex } });
    expect(JSON.stringify(raw())).not.toContain('executablePath');
  });

  it('профиль изображений — программа провайдера из реестра с моделью проекта, без модели текстового агента', () => {
    const executor = testAgentProviderInfo.executor!;
    expect(store.getImageAgent(TEST_AGENT_PROVIDER)).toEqual({ provider: executor });
    store.saveAgent(claude);
    expect(store.getImageAgent(TEST_AGENT_PROVIDER, '  ')).toEqual({ provider: executor });
    store.saveAgent(codex);
    expect(store.getImageAgent(TEST_AGENT_PROVIDER, ' image-model ')).toEqual({ provider: executor, model: 'image-model' });
    expect(store.getAgent()).toEqual(codex);
    // Провайдер без программы-агента и неизвестный id не дают профиля.
    expect(() => store.getImageAgent(TEST_PROVIDER)).toThrow(/не исполняется программой-агентом/);
    expect(() => store.getImageAgent('unknown')).toThrow(/не исполняется программой-агентом/);
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
