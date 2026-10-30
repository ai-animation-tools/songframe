/** Полные ошибки границ результата проверяются отдельно от удаления файлов. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkedBuiltOutput } from './built-output-path';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-output-path-'));
  mkdirSync(join(project, 'plan/batches/«Проба» & <1>'), { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('сохраняет сообщения об относительном и постороннем пути', () => {
  expect(() => checkedBuiltOutput(project, 'plan/batches/«Проба» & <1>', 'directory')).toThrow(new Error('Укажите абсолютный путь собранного результата.'));
  expect(() => checkedBuiltOutput(project, join(project, 'source/ролик.mp4'), 'file')).toThrow(
    new Error('Удалять можно только собранные результаты внутри plan/batches выбранного проекта.')
  );
});

it('различает отсутствующий результат, файл вместо каталога и каталог вместо файла', () => {
  expect(() => checkedBuiltOutput(project, join(project, 'plan/batches/нет'), 'directory')).toThrow(
    new Error('Результат отсутствует или путь содержит символическую ссылку. Обновите список.')
  );
  writeFileSync(join(project, 'plan/batches/файл'), 'результат');
  expect(() => checkedBuiltOutput(project, join(project, 'plan/batches/файл'), 'directory')).toThrow(
    new Error('Папка собранного результата отсутствует. Обновите список.')
  );
  mkdirSync(join(project, 'plan/batches/«Проба» & <1>/каталог'));
  expect(() => checkedBuiltOutput(project, join(project, 'plan/batches/«Проба» & <1>/каталог'), 'file')).toThrow(
    new Error('Собранный результат должен быть обычным файлом.')
  );
});

it('оставляет символическую ссылку и назначение доступными после отклонения', () => {
  const target = join(project, 'plan/batches/«Проба» & <1>');
  const link = join(project, 'plan/batches/ссылка');
  symlinkSync(target, link);
  expect(() => checkedBuiltOutput(project, link, 'directory')).toThrow(
    new Error('Результат отсутствует или путь содержит символическую ссылку. Обновите список.')
  );
  expect(existsSync(link)).toBe(true);
  expect(checkedBuiltOutput(project, target, 'directory')).toBe(target);
});
