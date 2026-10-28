import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from './settings';
import { prepareProjectCover } from './cover-provider';
import { registerTestAgentProvider, registerTestMediaProvider, TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo } from './testing/media-provider';

const adapterRunner = vi.fn();
const adapterCover = vi.fn(() => adapterRunner);
let restoreProvider: () => void;
beforeAll(() => {
  const restorePaid = registerTestMediaProvider();
  const restoreAgent = registerTestAgentProvider({ images: vi.fn(), cover: adapterCover });
  restoreProvider = () => {
    restoreAgent();
    restorePaid();
  };
});
afterAll(() => restoreProvider());
const executor = testAgentProviderInfo.executor!;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(image: { provider: string; model?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'songframe-cover-provider-'));
  roots.push(root);
  mkdirSync(join(root, 'plan'));
  writeFileSync(join(root, 'plan/project.json'), JSON.stringify({ name: 'Тест', generation: { image: { ...image, provider_selected: true }, video: null } }));
  const settings = new SettingsStore(join(root, 'local'));
  settings.saveAgent({ provider: 'claude', model: 'text-model' });
  return { input: { project: root, workDir: join(root, 'temporary'), prompt: 'Та же обложка', signal: new AbortController().signal }, settings };
}

describe('выбор провайдера обложки', () => {
  it('готовит обложку провайдера-агента под текстовым Claude: агент на провайдера изображений не влияет', async () => {
    const { input, settings } = fixture({ provider: TEST_AGENT_PROVIDER });
    const paid = vi.fn();
    const generate = vi.fn();
    const agent = vi.fn(() => generate);
    const prepared = await prepareProjectCover(input, { settings, paid, agent });
    expect(prepared.provider).toBe(TEST_AGENT_PROVIDER);
    expect(agent).toHaveBeenCalledWith(TEST_AGENT_PROVIDER, { provider: executor });
    expect(paid).not.toHaveBeenCalled();
  });

  it('по умолчанию берёт исполнителя обложки из адаптера провайдера', async () => {
    const { input, settings } = fixture({ provider: TEST_AGENT_PROVIDER, model: 'image-model' });
    adapterRunner.mockResolvedValueOnce({ path: 'cover.png' });
    const prepared = await prepareProjectCover(input, { settings, paid: vi.fn() });
    expect(adapterCover).toHaveBeenCalledWith({ config: { provider: executor, model: 'image-model' } });
    expect(await prepared.generate(input.signal)).toEqual({ path: 'cover.png' });
    expect(adapterRunner).toHaveBeenCalledWith(input);
  });

  it.each([TEST_AGENT_PROVIDER, TEST_PROVIDER])('не подготавливает сохранённый %s без маркера явного выбора', async (provider) => {
    const { input, settings } = fixture({ provider });
    writeFileSync(join(input.project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider } } }));
    const paid = vi.fn();
    const agent = vi.fn();
    await expect(prepareProjectCover(input, { settings, paid, agent })).rejects.toThrow('выберите провайдера изображений');
    expect(paid).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it.each([TEST_AGENT_PROVIDER, TEST_PROVIDER])('готовит %s и без выбранного агента', async (provider) => {
    const { input, settings } = fixture({ provider });
    settings.saveAgent(null);
    const generate = vi.fn();
    const paid = vi.fn(async () => ({ provider: TEST_PROVIDER, model: null, requestSha: 'sha', quote: null, generate }));
    const agent = vi.fn(() => generate);
    expect((await prepareProjectCover(input, { settings, paid, agent })).provider).toBe(provider);
    expect(provider === TEST_PROVIDER ? paid : agent).toHaveBeenCalledTimes(1);
    expect(provider === TEST_PROVIDER ? agent : paid).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('использует платного провайдера из проекта, не обращаясь к провайдеру-агенту или текстовому Claude', async () => {
    const { input, settings } = fixture({ provider: TEST_PROVIDER });
    const candidate = { provider: TEST_PROVIDER, model: 'image-model', requestSha: 'sha', quote: null, generate: vi.fn() };
    const paid = vi.fn(async () => candidate);
    const agent = vi.fn();
    expect(await prepareProjectCover(input, { settings, paid, agent })).toBe(candidate);
    expect(paid).toHaveBeenCalledWith(input, TEST_PROVIDER);
    expect(agent).not.toHaveBeenCalled();
  });

  it.each(['project-image-model', ''])('закрепляет проектную модель провайдера-агента «%s», не наследуя модель другого агента', async (model) => {
    const { input, settings } = fixture({ provider: TEST_AGENT_PROVIDER, model });
    settings.saveAgent({ provider: 'codex', model: 'text-model' });
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const agent = vi.fn(() => generate);
    const paid = vi.fn();
    const prepared = await prepareProjectCover(input, { settings, paid, agent });
    expect(agent).toHaveBeenCalledWith(TEST_AGENT_PROVIDER, { provider: executor, model: model || undefined });
    expect(prepared.model).toBe(model || null);
    expect(prepared.requestSha).toMatch(/^[a-f0-9]{64}$/);
    // Правка проекта после подготовки не меняет уже закреплённый запрос.
    writeFileSync(
      join(input.project, 'plan/project.json'),
      JSON.stringify({ generation: { image: { provider: TEST_AGENT_PROVIDER, model: 'changed-after-prepare', provider_selected: true } } })
    );
    await prepared.generate(input.signal);
    expect(prepared.model).toBe(model || null);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(input);
    expect(paid).not.toHaveBeenCalled();
  });

  it('не подменяет неизвестного провайдера и не запускает заранее отменённую подготовку', async () => {
    const { input, settings } = fixture({ provider: 'other' });
    const paid = vi.fn();
    const agent = vi.fn();
    await expect(prepareProjectCover(input, { settings, paid, agent })).rejects.toThrow('провайдера изображений');
    await expect(prepareProjectCover({ ...input, signal: AbortSignal.abort() }, { settings, paid, agent })).rejects.toThrow('остановлена');
    expect(agent).not.toHaveBeenCalled();
    expect(paid).not.toHaveBeenCalled();
  });
});
