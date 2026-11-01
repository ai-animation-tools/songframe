/** Контекст читается независимо от генерации; итоговый промпт выбирает пользователь в конструкторе. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TEXT_LIMIT } from './agent-manager';
import { readReferenceImageContext } from './reference-image-context';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'reference-image-context-'));
  mkdirSync(join(project, 'plan'));
  mkdirSync(join(project, 'source'));
  // Чтению конструктора не нужны выбор провайдера, вход или готовность агента.
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ name: 'Пробный клип' }));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));
function saved(): void {
  writeFileSync(
    join(project, 'source/manifest.json'),
    JSON.stringify({
      schema_version: 1,
      idea: { path: 'description.md' },
      lyrics: { path: 'text.md' }
    })
  );
  writeFileSync(join(project, 'source/description.md'), 'Сохранённая идея');
  writeFileSync(join(project, 'source/text.md'), 'Сохранённая песня');
  writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify({ visual_direction: 'Мягкий объёмный 3D, тёплый свет' }));
}
it('перед сценарием возвращает название и пустые необязательные части контекста', () => {
  expect(readReferenceImageContext(project)).toEqual({ clipName: 'Пробный клип', idea: '', lyrics: '', visualStyle: '' });
});
it('читает сохранённые идею, песню и стиль без композиции промпта', () => {
  saved();
  expect(readReferenceImageContext(project)).toEqual({
    clipName: 'Пробный клип',
    idea: 'Сохранённая идея',
    lyrics: 'Сохранённая песня',
    visualStyle: 'Мягкий объёмный 3D, тёплый свет'
  });
});
it('возвращает точный черновик исходников, а стиль читает из сохранённого сценария', () => {
  saved();
  expect(readReferenceImageContext(project, { idea: '  Черновик идеи\n', lyrics: '\nЧерновик песни  ' })).toEqual({
    clipName: 'Пробный клип',
    idea: '  Черновик идеи\n',
    lyrics: '\nЧерновик песни  ',
    visualStyle: 'Мягкий объёмный 3D, тёплый свет'
  });
});
it('переданный пустой черновик не заменяет сохранённым текстом', () => {
  saved();
  expect(readReferenceImageContext(project, { idea: '', lyrics: '' })).toMatchObject({ idea: '', lyrics: '' });
});
it('не игнорирует повреждённый манифест, стиль и явно указанный отсутствующий файл', () => {
  writeFileSync(join(project, 'source/manifest.json'), 'не JSON');
  expect(() => readReferenceImageContext(project)).toThrow(/контекст клипа/);
  saved();
  writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify({ visual_direction: 42 }));
  expect(() => readReferenceImageContext(project)).toThrow(/контекст клипа/);
  saved();
  rmSync(join(project, 'source/description.md'));
  expect(() => readReferenceImageContext(project)).toThrow(/контекст клипа/);
});
it('отказывает при превышении TEXT_LIMIT отдельным черновиком или полным ответом без усечения', () => {
  expect(() => readReferenceImageContext(project, { idea: 'x'.repeat(TEXT_LIMIT + 1) })).toThrow(/256 КБ/);
  expect(() =>
    readReferenceImageContext(project, {
      idea: 'x'.repeat(TEXT_LIMIT / 2),
      lyrics: 'y'.repeat(TEXT_LIMIT / 2)
    })
  ).toThrow(/256 КБ/);
});
it('не записывает файлы и не создаёт архив попытки при чтении контекста', () => {
  saved();
  const names = readdirSync(project, { recursive: true }).sort();
  const before = readFileSync(join(project, 'source/manifest.json'));
  readReferenceImageContext(project, { idea: 'Несохранённая идея' });
  expect(readdirSync(project, { recursive: true }).sort()).toEqual(names);
  expect(readFileSync(join(project, 'source/manifest.json'))).toEqual(before);
});
