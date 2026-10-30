/** Пользователь видит полный путь и исходную причину; отказ не заменяет прежнее локальное состояние. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readLocalJson, writeAtomicText } from './local-files';
import { initializeLocalStorage } from './local-storage';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'Файлы «&» <1> '));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('оставляет отсутствующий файл отсутствующим, а неверный JSON нетронутым с полной причиной', () => {
  const path = join(directory, 'состояние «&».json');
  expect(readLocalJson(path)).toBeNull();
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, '42');
  expect(() => readLocalJson(path)).toThrowError(
    new Error(`Не удалось прочитать ${path}: ожидался JSON-объект. Файл сохранён; исправьте его или перенесите в резервную папку.`)
  );
  expect(readFileSync(path, 'utf8')).toBe('42');
});

it('передаёт исходную ошибку замены файла и убирает временный файл после отказа', () => {
  const path = join(directory, 'занято «&»');
  mkdirSync(path);
  writeFileSync(join(path, 'исходник'), 'оставить');
  let failure: Error | undefined;
  try {
    writeAtomicText(path, 'новое');
  } catch (error) {
    failure = error as Error;
  }
  expect(failure).toBeInstanceOf(Error);
  const cause = failure!.cause as NodeJS.ErrnoException;
  expect(cause.code).toBe('EISDIR');
  expect(failure!.message).toBe(`Не удалось сохранить ${path}: ${cause.message}. Проверьте доступ на запись к папке.`);
  expect(readFileSync(join(path, 'исходник'), 'utf8')).toBe('оставить');
  expect(readdirSync(directory)).toEqual(['занято «&»']);
});

it('сообщает полный путь каталога состояния и исходную причину, сохраняя занявший путь файл', () => {
  const path = join(directory, 'состояние «&»');
  writeFileSync(path, 'оставить');
  let failure: Error | undefined;
  try {
    initializeLocalStorage(path);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure).toBeInstanceOf(Error);
  const cause = failure!.cause as NodeJS.ErrnoException;
  expect(cause.code).toBe('EEXIST');
  expect(failure!.message).toBe(`Не удалось подготовить локальное состояние (${path}): ${cause.message}`);
  expect(readFileSync(path, 'utf8')).toBe('оставить');
});
