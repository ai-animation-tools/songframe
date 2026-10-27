/** Проверки доступа используют подставную диагностику и не запускают внешние CLI. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import { SettingsStore } from './settings';
import { createAiAccess } from './ai-access';
import type { KlingAuth } from './kling-auth';

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
  settings.saveImageAgent({ provider: 'codex', model: 'image-model' });
  project();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const checkAgent = vi.fn<(config: AgentSettings) => Promise<AgentCheckResult>>(async () => ready);
  const checkKling = vi.fn<() => Promise<KlingAuth>>(async () => ({ status: 'authenticated' }));
  return { ai: createAiAccess({ settings: () => settings, checkAgent, checkKling }), checkAgent, checkKling };
}
describe('Явный выбор и доступность ИИ', () => {
  it('под Claude не читает профиль Codex, не проверяет его CLI и не разрешает изображения Codex', async () => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: 'codex', provider_selected: true });
    const getImageAgent = vi.spyOn(settings, 'getImageAgent');
    const { ai, checkAgent, checkKling } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({
      agent: { available: true },
      image: { selected: true, available: false, message: 'Для изображений Codex выберите агента Codex в настройках приложения.' }
    });
    const execute = vi.fn();
    await expect(ai.requireAccess(root, 'image').then(execute)).rejects.toThrow('выберите агента Codex');
    expect(execute).not.toHaveBeenCalled();
    expect(getImageAgent).not.toHaveBeenCalled();
    expect(checkAgent).toHaveBeenCalledTimes(1);
    expect(checkAgent).toHaveBeenCalledWith({ provider: 'claude' });
    expect(checkKling).not.toHaveBeenCalled();
  });

  it('разрешает изображения Kling при выбранном Claude без чтения профиля Codex', async () => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: 'kling', provider_selected: true });
    const getImageAgent = vi.spyOn(settings, 'getImageAgent');
    const { ai } = fixture();
    await expect(ai.requireAccess(root, 'image')).resolves.toBeUndefined();
    expect(getImageAgent).not.toHaveBeenCalled();
  });

  it('без глобального агента не проверяет CLI, аккаунты или сохранённые media profiles', async () => {
    project({ provider: 'codex', provider_selected: true }, { provider: 'kling', provider_selected: true });
    const { ai, checkAgent, checkKling } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({ agent: { selected: false, available: false }, image: { available: false }, video: { available: false } });
    await expect(ai.requireAccess(root, 'image')).rejects.toThrow('Сначала выберите агента');
    expect(checkAgent).not.toHaveBeenCalled();
    expect(checkKling).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('сохранённый provider без явного выбора (%s) не вызывает media диагностику', async (provider_selected) => {
    settings.saveAgent({ provider: 'claude' });
    project({ provider: 'codex', provider_selected }, { provider: 'kling', provider_selected });
    const { ai, checkAgent, checkKling } = fixture();
    expect(await ai.getAccess(root)).toMatchObject({ agent: { available: true }, image: { selected: false }, video: { selected: false } });
    await expect(ai.requireAccess(root, 'image')).rejects.toThrow('выберите провайдера изображений');
    expect(checkAgent).toHaveBeenCalledTimes(1);
    expect(checkKling).not.toHaveBeenCalled();
  });

  it('отсутствующий CLI блокирует запуск до побочного действия', async () => {
    settings.saveAgent({ provider: 'codex' });
    project({ provider: 'codex', provider_selected: true });
    const { ai, checkAgent } = fixture();
    checkAgent.mockResolvedValue({ ...ready, availability: 'not_found', authorization: 'unknown', message: 'CLI не найден.' });
    const execute = vi.fn();
    await expect(ai.requireAccess(root, 'image').then(execute)).rejects.toThrow('CLI не найден');
    expect(execute).not.toHaveBeenCalled();
    expect(checkAgent).toHaveBeenCalledTimes(1);
  });

  it('проверяет отдельный image CLI только после выбора провайдера и блокирует неизвестный вход Kling', async () => {
    settings.saveAgent({ provider: 'codex', executablePath: '/tmp/global-codex' });
    project({ provider: 'codex', provider_selected: true }, { provider: 'kling', provider_selected: true });
    const { ai, checkAgent, checkKling } = fixture();
    checkAgent.mockImplementation(async (config) =>
      config.model === 'image-model' ? { ...ready, authorization: 'unknown', message: 'Вход Codex не подтверждён.' } : ready
    );
    checkKling.mockResolvedValue({ status: 'unknown' });
    const access = await ai.getAccess(root);
    expect(access).toMatchObject({ agent: { available: true }, image: { available: false }, video: { available: false } });
    expect(checkAgent).toHaveBeenCalledWith(settings.getImageAgent());
  });

  it('явный выбор агента и обоих доступных провайдеров разрешает действия', async () => {
    settings.saveAgent({ provider: 'codex' });
    project({ provider: 'codex', provider_selected: true }, { provider: 'kling', provider_selected: true });
    const { ai, checkAgent, checkKling } = fixture();
    const execute = vi.fn();
    await ai.requireAccess(root, 'image').then(execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await ai.getAccess(root)).toMatchObject({ agent: { available: true }, image: { available: true }, video: { available: true } });
    expect(checkAgent).toHaveBeenCalledWith(settings.getAgent());
    expect(checkKling).toHaveBeenCalled();
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
