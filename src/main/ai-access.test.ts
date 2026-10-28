/** Проверки доступа используют подставную диагностику и не запускают внешние CLI. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import type { ProviderAuth } from '@shared/media-providers';
import { SettingsStore } from './settings';
import { createAiAccess } from './ai-access';
import { registerTestAgentProvider, registerTestMediaProvider, TEST_AGENT_PROVIDER, TEST_PROVIDER } from './testing/media-provider';

let restoreProvider: () => void;
beforeAll(() => {
  const restorePaid = registerTestMediaProvider();
  // Провайдер изображений `test-agent` исполняет программа Codex из реестра агентов.
  const restoreAgent = registerTestAgentProvider();
  restoreProvider = () => {
    restoreAgent();
    restorePaid();
  };
});
afterAll(() => restoreProvider());

let root: string;
let settings: SettingsStore;
const ready: AgentCheckResult = { availability: 'available', authorization: 'authenticated', message: 'Вход подтверждён.' };
function project(image: Record<string, unknown> = {}, video: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'plan/project.json'), JSON.stringify({ generation: { image, video } }));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-ai-access-'));
  mkdirSync(join(root, 'plan'));
  settings = new SettingsStore(join(root, 'local'));
  project();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const checkAgent = vi.fn<(config: AgentSettings) => Promise<AgentCheckResult>>(async () => ready);
  const checkProviderAuth = vi.fn<(provider: string) => Promise<ProviderAuth>>(async () => ({ status: 'authenticated' }));
  return { ai: createAiAccess({ settings: () => settings, checkAgent, checkProviderAuth }), checkAgent, checkProviderAuth };
}
describe('Явный выбор и доступность ИИ', () => {
  it('под Claude разрешает изображения Codex по доступности самого Codex', async () => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true });
    const { ai, checkAgent, checkProviderAuth } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({ agent: { available: true }, image: { selected: true, available: true } });
    await expect(ai.requireAccess(root, 'image')).resolves.toBeUndefined();
    // Генерацию изображений запускает Codex, а не текстовый агент: проверяется именно он.
    expect(checkAgent).toHaveBeenCalledWith({ provider: 'claude' });
    expect(checkAgent).toHaveBeenCalledWith({ provider: 'codex' });
    expect(checkProviderAuth).not.toHaveBeenCalled();
  });

  it('не разрешает изображения Codex, если сам Codex не найден', async () => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true });
    const { ai, checkAgent } = fixture();
    checkAgent.mockImplementation(async (config) =>
      config.provider === 'codex' ? { availability: 'not_found', authorization: 'unknown', message: 'Codex не найден.' } : ready
    );
    const execute = vi.fn();
    await expect(ai.requireAccess(root, 'image').then(execute)).rejects.toThrow('Codex не найден.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('разрешает изображения платного провайдера при выбранном Claude без чтения профиля Codex', async () => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: TEST_PROVIDER, provider_selected: true });
    const getImageAgent = vi.spyOn(settings, 'getImageAgent');
    const { ai } = fixture();
    await expect(ai.requireAccess(root, 'image')).resolves.toBeUndefined();
    expect(getImageAgent).not.toHaveBeenCalled();
  });

  it('без агента запрещает только текстовые этапы, а медиа проверяет по своим провайдерам', async () => {
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true }, { provider: TEST_PROVIDER, provider_selected: true });
    const { ai, checkAgent, checkProviderAuth } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({ agent: { selected: false, available: false }, image: { available: true }, video: { available: true } });
    await expect(ai.requireAccess(root, 'agent')).rejects.toThrow('Сначала выберите агента');
    await expect(ai.requireAccess(root, 'image')).resolves.toBeUndefined();
    await expect(ai.requireAccess(root, 'video')).resolves.toBeUndefined();
    expect(checkAgent).not.toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }));
    expect(checkProviderAuth).toHaveBeenCalledWith(TEST_PROVIDER);
  });

  it.each([undefined, false])('сохранённый provider без явного выбора (%s) не вызывает media диагностику', async (provider_selected) => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected }, { provider: TEST_PROVIDER, provider_selected });
    const { ai, checkAgent, checkProviderAuth } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({ agent: { available: true }, image: { selected: false }, video: { selected: false } });
    await expect(ai.requireAccess(root, 'image')).rejects.toThrow('выберите провайдера изображений');
    expect(checkAgent).toHaveBeenCalledTimes(1);
    expect(checkProviderAuth).not.toHaveBeenCalled();
  });

  it('отсутствующий CLI блокирует запуск до побочного действия', async () => {
    settings.saveAgent({ provider: 'codex' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true });
    const { ai, checkAgent } = fixture();
    checkAgent.mockResolvedValue({ ...ready, availability: 'not_found', authorization: 'unknown', message: 'Codex не найден.' });
    const execute = vi.fn();
    await expect(ai.requireAccess(root, 'image').then(execute)).rejects.toThrow('Codex не найден');
    expect(execute).not.toHaveBeenCalled();
    expect(checkAgent).toHaveBeenCalledTimes(1);
  });

  it('проверяет Codex изображений без модели текстового агента и блокирует неизвестный вход платного провайдера', async () => {
    settings.saveAgent({ provider: 'codex', model: 'text-model' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true }, { provider: TEST_PROVIDER, provider_selected: true });
    const { ai, checkAgent, checkProviderAuth } = fixture();
    checkAgent.mockImplementation(async (config) =>
      config.model === 'text-model' ? ready : { ...ready, authorization: 'unknown', message: 'Вход Codex не подтверждён.' }
    );
    checkProviderAuth.mockResolvedValue({ status: 'unknown' });
    const access = await ai.getAccess(root);
    expect(access).toMatchObject({ agent: { available: true }, image: { available: false }, video: { available: false } });
    expect(checkAgent).toHaveBeenCalledWith({ provider: 'codex', model: 'text-model' });
    expect(checkAgent).toHaveBeenCalledWith({ provider: 'codex' });
    expect(checkAgent).toHaveBeenCalledTimes(2);
  });

  it('явный выбор агента и обоих доступных провайдеров разрешает действия', async () => {
    settings.saveAgent({ provider: 'codex' });
    project({ provider: TEST_AGENT_PROVIDER, provider_selected: true }, { provider: TEST_PROVIDER, provider_selected: true });
    const { ai, checkAgent, checkProviderAuth } = fixture();
    const execute = vi.fn();
    await ai.requireAccess(root, 'image').then(execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await ai.getAccess(root)).toMatchObject({ agent: { available: true }, image: { available: true }, video: { available: true } });
    expect(checkAgent).toHaveBeenCalledWith(settings.getAgent());
    expect(checkProviderAuth).toHaveBeenCalledWith(TEST_PROVIDER);
  });

  it('отключение агента во время диагностики отменяет разрешение', async () => {
    settings.saveAgent({ provider: 'claude' });
    const { ai, checkAgent } = fixture();
    checkAgent.mockImplementation(async () => {
      settings.saveAgent(null);
      return ready;
    });
    const execute = vi.fn();
    await expect(ai.requireAccess(root, 'agent').then(execute)).rejects.toThrow('Сначала выберите агента');
    expect(execute).not.toHaveBeenCalled();
  });
});
