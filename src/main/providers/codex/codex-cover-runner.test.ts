/** Исполнитель обложки Codex: фиксированный промпт, явная модель и временный проект без запуска настоящего агента. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import type { CoverManager } from '../../cover-generation';
import type { SettingsStore } from '../../settings';
import { createCodexCoverRunner } from './codex-cover-runner';

let root: string;
let workDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-codex-cover-'));
  workDir = join(root, 'image-jobs', 'attempt');
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Call {
  input: AgentStartInput;
  workDir: string;
  config: AgentSettings;
  settings: SettingsStore;
}
function fakeManager(result: string, calls: Call[]): (settings: SettingsStore) => CoverManager {
  return (settings: SettingsStore): CoverManager => {
    let job: AgentJob;
    return {
      startImages: (input, directory, config) => {
        calls.push({ input, workDir: directory, config, settings });
        job = { id: 'job', status: 'completed', exitCode: 0, result } as AgentJob;
        return job;
      },
      get: () => job,
      onEvent: (_listener: (event: AgentEvent) => void) => () => undefined,
      shutdownAndWait: async () => undefined
    };
  };
}

describe('обложка Codex', () => {
  it('передаёт фиксированный промпт, пользовательский контекст и закреплённую модель во временный проект', async () => {
    const calls: Call[] = [];
    const config = { provider: 'codex' as const, model: 'cover-model' };
    const runner = createCodexCoverRunner({ config, createManager: fakeManager('{"path":"cover.png"}', calls) });
    expect(await runner({ workDir, project: '/fixture/project', prompt: '  Ёж у костра  ', signal: new AbortController().signal })).toEqual({
      path: 'cover.png'
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.config).toBe(config);
    expect(call.workDir).toBe(workDir);
    expect(call.input.project).toBe(root);
    expect(call.input.task).toBe('Обложка проекта');
    expect(call.input.prompt).toContain('image_gen');
    expect(call.input.context).toBe(JSON.stringify({ userPrompt: '  Ёж у костра  ' }));
    // История и настройки временного проекта остаются в папке обложки.
    expect(call.settings.localDir).toBe(root);
    expect(readFileSync(join(root, 'plan/project.json'), 'utf8')).toBe('{}');
    expect(existsSync('/fixture/project')).toBe(false);
  });

  it.each([
    ['не JSON', 'Агент не вернул путь к созданной обложке.'],
    ['{"path":1}', 'Агент вернул неверный результат обложки. Ожидается JSON с одним полем path.'],
    ['{"path":"cover.png","extra":true}', 'Агент вернул неверный результат обложки. Ожидается JSON с одним полем path.']
  ])('отклоняет неверный финальный ответ %s', async (result, message) => {
    const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager(result, []) });
    await expect(runner({ workDir, project: root, prompt: 'Обложка', signal: new AbortController().signal })).rejects.toThrow(message);
  });

  it('не запускает заранее отменённую генерацию', async () => {
    const calls: Call[] = [];
    const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager('{"path":"cover.png"}', calls) });
    await expect(runner({ workDir, project: root, prompt: 'Обложка', signal: AbortSignal.abort() })).rejects.toThrow('Генерация обложки остановлена.');
    expect(calls).toEqual([]);
  });
});

it('передаёт Codex опоры того же объекта приватными копиями и требует использовать их в image_gen', async () => {
  const source = join(root, 'original.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(source, bytes);
  const references = [{ path: source, label: 'Олег: лицо', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
  const calls: Call[] = [];
  const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager('{"path":"reference.png"}', calls) });
  await runner({
    workDir,
    project: root,
    prompt: 'Тот же Олег. Стиль: объёмная анимация.',
    purpose: 'reference',
    references,
    signal: new AbortController().signal
  });
  const context = JSON.parse(calls[0].input.context!);
  expect(context.userPrompt).toBe('Тот же Олег. Стиль: объёмная анимация.');
  expect(context.referenceImages).toEqual([{ ...references[0], path: 'references/01.png' }]);
  expect(readFileSync(join(workDir, context.referenceImages[0].path))).toEqual(bytes);
  expect(readFileSync(source)).toEqual(bytes);
  expect(calls[0].input.prompt).toContain('передай их встроенному image_gen как изображения-референсы');
  expect(calls[0].input.prompt).toContain('Сохрани внешность');
  expect(calls[0].input.prompt).not.toContain('квадратную обложку');
});

it('отклоняет изменённые байты согласованной опоры до запуска Codex', async () => {
  const source = join(root, 'changed.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(source, bytes);
  const calls: Call[] = [];
  const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager('{"path":"reference.png"}', calls) });
  await expect(
    runner({
      workDir,
      project: root,
      prompt: 'Олег',
      purpose: 'reference',
      references: [{ path: source, label: 'Лицо', sha256: 'a'.repeat(64), bytes: bytes.length }],
      signal: new AbortController().signal
    })
  ).rejects.toThrow('Опорные изображения изменились');
  expect(calls).toEqual([]);
});

// Финальный редактор владеет описаниями опор: адаптер сохраняет его байты и не переносит текст в метаданные.
it.each([
  ['без описаний', '  Сохрани внешность Олега.\r\nСтиль: объёмная анимация.  '],
  ['с описаниями', '  Сохрани внешность Олега.\r\n\r\nОписания выбранных опор:\r\n1. Шрам над левой бровью.\r\n2. Синяя куртка.  '],
  ['после ручной правки', '  Пользователь заменил весь промпт.\r\nТолько силуэт, без куртки.\n  ']
])('передаёт финальный промпт референса Codex дословно: %s', async (_mode, prompt) => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  const references = ['Опора 1', 'Опора 2'].map((label, index) => {
    const path = join(root, `original-${index + 1}.png`);
    writeFileSync(path, bytes);
    return { path, label, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  const calls: Call[] = [];
  const runner = createCodexCoverRunner({ config: { provider: 'codex' }, createManager: fakeManager('{"path":"reference.png"}', calls) });
  await runner({ workDir, project: root, prompt, purpose: 'reference', references, signal: new AbortController().signal });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].input.context!)).toEqual({
    userPrompt: prompt,
    referenceImages: references.map((image, index) => ({ ...image, path: `references/0${index + 1}.png` }))
  });
  expect(calls[0].input.prompt).not.toContain('Шрам над левой бровью');
  expect(calls[0].input.prompt).not.toContain('Синяя куртка');
});
