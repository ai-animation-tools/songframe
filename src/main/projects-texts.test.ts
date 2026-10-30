/** Полные ошибки проекта проверяются без словаря, вместе с порядком проверок и сохранностью файлов. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Projects, validateNewProject } from './projects';
import { LocalState } from './state';
import { computeStatus } from './status';
import { copyTemplate } from './template';

let directory: string;
let state: LocalState;
let projects: Projects;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'Проекты «&» '));
  state = new LocalState(join(directory, 'состояние'));
  projects = new Projects(state, null, 'linux');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('Полные сообщения проектов', () => {
  it('возвращает проверки имени, пути и MP4 в прежнем порядке и до записи файлов', () => {
    const input = { name: ' ', path: '', animaticVideo: 'плохое имя.mov' };
    const expected = [
      'Укажите название проекта.',
      'Укажите полный путь к папке проекта.',
      'Имя MP4: латиница, цифры, точка, дефис, подчёркивание и расширение .mp4.'
    ];
    expect(validateNewProject(input)).toEqual(expected);
    expect(() => projects.create(input)).toThrowError(new Error(expected.join(' ')));
    expect(existsSync(state.localDir)).toBe(false);
    expect(validateNewProject({ name: 'Клип', path: 'относительный' })).toEqual(['Путь должен быть абсолютным.']);
  });

  it('сохраняет полный путь и спецсимволы в причинах отсутствующего родителя и занятой папки', () => {
    const parent = join(directory, 'нет «&» <1>');
    expect(validateNewProject({ name: 'Клип', path: join(parent, 'проект') })).toEqual([`Родительская папка не существует: ${parent}`]);
    expect(validateNewProject({ name: 'Клип', path: directory })).toEqual([
      'Папка уже существует: выберите новый путь или откройте её как существующий проект.'
    ]);
  });

  it('отклоняет отсутствующий проект и ресурсы без создания папки или переключения проекта', () => {
    state.writeCurrent('/старый «&» проект');
    const before = readFileSync(state.currentFile, 'utf8');
    const target = join(directory, 'новый «&» <1>');
    expect(() => projects.open(target)).toThrowError(new Error(`В папке нет plan/project.json с названием проекта: ${target}`));
    expect(() => projects.create({ name: 'Клип', path: target })).toThrowError(
      new Error('Корень комплекса не найден: шаблон проекта недоступен. Укажите его на странице «Среда».')
    );
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(state.currentFile, 'utf8')).toBe(before);
    expect(existsSync(state.historyFile)).toBe(false);
  });

  it.each([
    [' ', 'Название проекта не может быть пустым.'],
    ['До\nпосле', 'Название проекта содержит недопустимый символ.'],
    ['До\0после', 'Название проекта содержит недопустимый символ.']
  ])('отклоняет название %j без изменения маркера, истории и текущего проекта', (name, expected) => {
    const target = join(directory, 'клип');
    const marker = join(target, 'plan/project.json');
    json(marker, { name: 'До «&»', custom: ['оставить'] });
    projects.open(target);
    const files = [marker, state.currentFile, state.historyFile];
    const before = files.map((file) => readFileSync(file, 'utf8'));
    expect(() => projects.rename(target, name)).toThrowError(new Error(expected));
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('не переименовывает повреждённый маркер и не копирует отсутствующий шаблон', () => {
    const target = join(directory, 'клип');
    const marker = join(target, 'plan/project.json');
    json(marker, { custom: ['оставить'] });
    const before = readFileSync(marker, 'utf8');
    expect(() => projects.rename(target, 'После')).toThrowError(new Error('В папке нет корректного plan/project.json с названием проекта.'));
    expect(readFileSync(marker, 'utf8')).toBe(before);
    const template = join(directory, 'шаблон «&» <1>');
    const output = join(directory, 'новый');
    expect(() => copyTemplate(template, output, {})).toThrowError(new Error(`Шаблон проекта не найден: ${template}`));
    expect(existsSync(output)).toBe(false);
  });

  it('сохраняет повреждённые текущий проект и историю при попытке записи', () => {
    json(state.currentFile, { schema_version: 2, path: '/до' });
    const current = readFileSync(state.currentFile, 'utf8');
    expect(() => state.writeCurrent('/после')).toThrowError(
      new Error(`Неверный формат ${state.currentFile}. Файл сохранён; выберите резервную копию или исправьте path.`)
    );
    expect(readFileSync(state.currentFile, 'utf8')).toBe(current);
    json(state.historyFile, { schema_version: 1, projects: [{ path: 42 }] });
    const history = readFileSync(state.historyFile, 'utf8');
    expect(() => state.touchHistory('/после', 'После')).toThrowError(
      new Error(`Неверный формат ${state.historyFile}. Файл сохранён; исправьте список projects.`)
    );
    expect(readFileSync(state.historyFile, 'utf8')).toBe(history);
  });

  it('сохраняет порядок полных диагностик повреждённых данных и не меняет файлы проекта', () => {
    expect(computeStatus(directory).problems).toEqual(['Нет plan/project.json с названием проекта.']);
    json(join(directory, 'plan/project.json'), { name: 'Клип «&»' });
    const inputs = [
      ['source/manifest.json', { track: {} }],
      ['plan/audio/timing.json', { lines: [] }],
      ['plan/cast.json', {}],
      ['plan/treatment.json', { sequences: [] }],
      ['plan/scenes.json', { scenes: [] }]
    ] as const;
    for (const [file, value] of inputs) json(join(directory, file), value);
    const before = inputs.map(([file]) => readFileSync(join(directory, file), 'utf8'));
    expect(computeStatus(directory)).toMatchObject({
      name: 'Клип «&»',
      state: 'empty',
      problems: [
        'source/manifest.json есть, но в нём нет трека, текста песни или идеи.',
        'plan/audio/timing.json не содержит строк разметки.',
        'plan/cast.json повреждён.',
        'plan/treatment.json повреждён или пуст.',
        'plan/scenes.json повреждён или не содержит сцен.'
      ]
    });
    expect(inputs.map(([file]) => readFileSync(join(directory, file), 'utf8'))).toEqual(before);
    writeFileSync(join(directory, 'source/manifest.json'), '{');
    expect(computeStatus(directory).problems[0]).toBe('source/manifest.json повреждён.');
  });
});
