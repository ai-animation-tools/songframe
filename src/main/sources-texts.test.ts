/** Ожидания фраз независимы от словаря: проверяем диагностику вместе с отказом записи исходников. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReferenceInput, SourcesInput } from '@shared/types';
import { saveSources, validateKinds, validateReferences, validateSources, viewSources } from './sources';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-source-texts-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));
const emptyInput = (): SourcesInput => ({ track: null, lyrics: null, idea: null, cover: null, references: [] });
const reference = (changes: Partial<ReferenceInput>): ReferenceInput => ({
  id: 'hero',
  kind: 'character',
  name: 'Герой',
  short_name: '',
  description: '',
  prompt: '',
  files: [],
  ...changes
});

describe('готовая диагностика исходников', () => {
  it('сохраняет порядок, кавычки и значения в ошибках типов и референсов', () => {
    expect(
      validateKinds([
        { id: 'Bad', label: 'Тип «&»', dir: 'bad dir' },
        { id: 'Bad', label: '', dir: 'bad dir' },
        { id: 'world', label: 'Мир', dir: 'world' }
      ])
    ).toEqual([
      'Код типа «Тип «&»»: латиница в нижнем регистре, цифры и подчёркивание.',
      'Папка типа Bad: латиница, цифры, дефис и подчёркивание.',
      'Код типа «Bad»: латиница в нижнем регистре, цифры и подчёркивание.',
      'У типа Bad нет подписи.',
      'Папка типа Bad: латиница, цифры, дефис и подчёркивание.',
      'Код типа повторяется: Bad.',
      'Папка повторяется: bad dir.',
      'Тип world зарезервирован для общих условий сцены.'
    ]);
    expect(
      validateReferences([reference({ id: '', name: '', kind: 'missing' }), reference({ id: '', name: 'Имя «&»', files: [{ view: 'full', note: '' }] })], [])
    ).toEqual([
      'Код референса «(без имени)»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.',
      'У референса  нет названия.',
      'У референса  неизвестный тип missing: добавьте тип в список типов.',
      'У референса  нет ни одного изображения.',
      'Код референса «Имя «&»»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.',
      'Код референса повторяется: .',
      'У референса  неизвестный тип character: добавьте тип в список типов.',
      'У референса  файл без пути.'
    ]);
  });

  it('возвращает полные пути и прежнюю пунктуацию, не создавая манифест при ошибках', () => {
    const track = join(project, 'нет «&».mp3');
    const cover = join(project, 'нет «&».png');
    const input: SourcesInput = { ...emptyInput(), track: { path: track }, lyrics: { text: ' ' }, idea: { text: '' }, cover: { path: cover } };
    const expected = [
      `Файл трека не найден: ${track}`,
      'Текст песни: пустой текст.',
      'Идея клипа: пустой текст.',
      'В тексте песни нет ни одной строки. Добавьте слова песни под заголовком секции.',
      `Файл обложки не найден: ${cover}`
    ];
    const problems = validateSources(project, input);
    expect(problems).toEqual(expected);
    expect(() => saveSources(project, input)).toThrow(expected.join(' '));
    expect(existsSync(join(project, 'source/manifest.json'))).toBe(false);
  });

  it('показывает отсутствующие файлы описи по их назначению и не меняет её данные', () => {
    mkdirSync(join(project, 'source'));
    const file = (path: string) => ({ path, sha256: 'hash', bytes: 1 });
    const manifest = {
      schema_version: 1,
      track: file('track.mp3'),
      lyrics: file('text.md'),
      idea: file('description.md'),
      cover: file('cover.png'),
      references: [{ id: 'hero', files: [file('heroes/вид «&».png')] }]
    };
    writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
    const view = viewSources(project);
    expect(view.problems).toEqual([
      'Трек: файл track.mp3 отсутствует.',
      'Текст песни: файл text.md отсутствует.',
      'Идея: файл description.md отсутствует.',
      'Обложка: файл cover.png отсутствует.',
      'Референс hero: файл heroes/вид «&».png отсутствует.'
    ]);
    expect(view.manifest).toEqual(manifest);
    expect(view.referenceFilePaths).toEqual({ 'heroes/вид «&».png': join(project, 'source/heroes/вид «&».png') });
  });
});
