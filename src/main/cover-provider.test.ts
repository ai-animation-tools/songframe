import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from './settings';
import { prepareProjectCover } from './cover-provider';

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
  it('готовит обложку Codex под текстовым Claude: агент на провайдера изображений не влияет', async () => {
    const { input, settings } = fixture({ provider: 'codex' });
    const kling = vi.fn();
    const generate = vi.fn();
    const codex = vi.fn(() => generate);
    const prepared = await prepareProjectCover(input, { settings, kling, codex });
    expect(prepared.provider).toBe('codex');
    expect(codex).toHaveBeenCalledWith({ provider: 'codex' });
    expect(kling).not.toHaveBeenCalled();
  });

  it.each(['codex', 'kling'])('не подготавливает сохранённый %s без маркера явного выбора', async (provider) => {
    const { input, settings } = fixture({ provider });
    writeFileSync(join(input.project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider } } }));
    const kling = vi.fn();
    const codex = vi.fn();
    await expect(prepareProjectCover(input, { settings, kling, codex })).rejects.toThrow('выберите провайдера изображений');
    expect(kling).not.toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
  });

  it.each(['codex', 'kling'] as const)('готовит %s и без выбранного агента', async (provider) => {
    const { input, settings } = fixture({ provider });
    settings.saveAgent(null);
    const generate = vi.fn();
    const kling = vi.fn(async () => ({ provider: 'kling' as const, model: null, requestSha: 'sha', quote: null, generate }));
    const codex = vi.fn(() => generate);
    expect((await prepareProjectCover(input, { settings, kling, codex })).provider).toBe(provider);
    expect(provider === 'kling' ? kling : codex).toHaveBeenCalledTimes(1);
    expect(provider === 'kling' ? codex : kling).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('использует Kling из проекта, не обращаясь к Codex или текстовому Claude', async () => {
    const { input, settings } = fixture({ provider: 'kling' });
    const candidate = { provider: 'kling' as const, model: 'image-model', requestSha: 'sha', quote: null, generate: vi.fn() };
    const kling = vi.fn(async () => candidate);
    const codex = vi.fn();
    expect(await prepareProjectCover(input, { settings, kling, codex })).toBe(candidate);
    expect(kling).toHaveBeenCalledWith(input);
    expect(codex).not.toHaveBeenCalled();
  });

  it.each(['project-image-model', ''])('закрепляет проектную модель Codex «%s», не наследуя модель другого агента', async (model) => {
    const { input, settings } = fixture({ provider: 'codex', model });
    settings.saveAgent({ provider: 'codex', model: 'text-model' });
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const codex = vi.fn(() => generate);
    const kling = vi.fn();
    const prepared = await prepareProjectCover(input, { settings, kling, codex });
    expect(codex).toHaveBeenCalledWith({ provider: 'codex', model: model || undefined });
    expect(prepared.model).toBe(model || null);
    expect(prepared.requestSha).toMatch(/^[a-f0-9]{64}$/);
    // Правка проекта после подготовки не меняет уже закреплённый запрос.
    writeFileSync(
      join(input.project, 'plan/project.json'),
      JSON.stringify({ generation: { image: { provider: 'codex', model: 'changed-after-prepare', provider_selected: true } } })
    );
    await prepared.generate(input.signal);
    expect(prepared.model).toBe(model || null);
    expect(codex).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(input);
    expect(kling).not.toHaveBeenCalled();
  });

  it('не подменяет неизвестного провайдера и не запускает заранее отменённую подготовку', async () => {
    const { input, settings } = fixture({ provider: 'other' });
    const kling = vi.fn();
    const codex = vi.fn();
    await expect(prepareProjectCover(input, { settings, kling, codex })).rejects.toThrow('провайдера изображений');
    await expect(prepareProjectCover({ ...input, signal: AbortSignal.abort() }, { settings, kling, codex })).rejects.toThrow('остановлена');
    expect(codex).not.toHaveBeenCalled();
    expect(kling).not.toHaveBeenCalled();
  });
});
