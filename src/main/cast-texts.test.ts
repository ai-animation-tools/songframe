import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CastEntity, CastFile, SourceManifest } from '@shared/types';
import { castFromSources, initCast, loadDefaults, normalizeCast, validateCast, viewCast, writeCast } from './cast';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'cast-texts-'));
  roots.push(root);
  mkdirSync(join(root, 'plan'));
  mkdirSync(join(root, 'source'));
  return root;
}

function entity(overrides: Partial<CastEntity> = {}): CastEntity {
  return { id: 'hero', kind: 'character', name: 'Герой «А» & Б', short_name: '', role: '', appearance: '', images: [], initial_state: {}, ...overrides };
}

function cast(entities: CastEntity[] = [entity()]): CastFile {
  return { schema_version: 1, entities, properties: {} };
}

function manifest(): SourceManifest {
  return {
    schema_version: 1,
    kinds: [],
    track: null,
    lyrics: null,
    idea: null,
    cover: null,
    updated_at: '',
    references: ['hero', 'boat'].map((id) => ({ id, kind: 'prop', name: id, short_name: id, description: '', prompt: null, files: [] }))
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('дословные сообщения главного процесса о кастинге', () => {
  // Ожидания независимы от словаря: проверяем реальные сообщения API и порядок нескольких проблем.
  it('сохраняет все фразы проверки сущности и параметры со спецсимволами', () => {
    expect(
      validateCast(
        cast([
          entity({ id: 'Bad id', kind: 'Bad kind', images: ['heroes/кадр & 1.gif'], initial_state: { 'Bad key': '', position: ' ' } }),
          entity({ id: 'Bad id', name: '' }),
          entity({ id: 'world_a', kind: 'world' }),
          entity({ id: 'world_b', kind: 'world' })
        ])
      )
    ).toEqual([
      'Код сущности «Герой «А» & Б»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.',
      'Герой «А» & Б: тип должен быть кодом латиницей.',
      'Герой «А» & Б: путь изображения должен быть вида heroes/<файл>.png: heroes/кадр & 1.gif',
      'Герой «А» & Б: свойство Bad key должно быть кодом латиницей.',
      'Герой «А» & Б: свойство Bad key пустое.',
      'Герой «А» & Б: свойство position пустое.',
      'Код сущности «Bad id»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.',
      'Код сущности повторяется: Bad id.',
      'Сущность Bad id: нет названия.',
      'Сущность типа world должна быть одна.'
    ]);
    expect(validateCast(cast([entity({ id: '', name: '' })]))).toEqual([
      'Код сущности «(без имени)»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.',
      'Сущность : нет названия.'
    ]);
  });

  it('возвращает одинаковую ошибку формата из проверки и нормализации', () => {
    const input = { ...cast(), schema_version: 2 };
    expect(validateCast(input as unknown as CastFile)).toEqual(['cast.json: нужны schema_version 1, entities и properties.']);
    expect(() => normalizeCast(input, null)).toThrowError('cast.json: нужны schema_version 1, entities и properties.');
  });

  it('сообщает ошибки структуры и словаря без изменения исходных формулировок', () => {
    expect(() => normalizeCast({ ...cast(), entities: [{}] }, null)).toThrowError('cast.json: неверная структура сущности.');
    expect(() => normalizeCast({ ...cast(), properties: { character: [{ key: 'note', label: ' ' }] } }, null)).toThrowError(
      'cast.json: неверный словарь свойств.'
    );
    expect(() =>
      normalizeCast(
        {
          ...cast(),
          properties: {
            character: [
              { key: 'note', label: 'Заметка' },
              { key: 'note', label: 'Дубль' }
            ]
          }
        },
        null
      )
    ).toThrowError('cast.json: свойство note повторяется в словаре типа character.');
    expect(() => normalizeCast(cast([entity({ id: 'Bad id', kind: 'Bad kind' })]), null)).toThrowError(
      'Код сущности «Герой «А» & Б»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы. Герой «А» & Б: тип должен быть кодом латиницей.'
    );
  });

  it('показывает повреждённый cast.json и список недостающих референсов', () => {
    const root = project();
    writeFileSync(join(root, 'plan', 'cast.json'), '{');
    expect(viewCast(root, null).problems).toEqual(['plan/cast.json повреждён.']);
    writeFileSync(join(root, 'plan', 'cast.json'), JSON.stringify(cast([])));
    writeFileSync(join(root, 'source', 'manifest.json'), JSON.stringify(manifest()));
    expect(viewCast(root, null).problems).toEqual(['В исходниках есть референсы без сущности в кастинге: hero, boat. Нажмите «Дополнить из исходников».']);
  });

  it('передаёт ошибки отсутствующего манифеста и исходного изображения', () => {
    const root = project();
    expect(() => initCast(root, null)).toThrowError('Нет source/manifest.json: сначала загрузите исходники.');
    expect(() => writeCast(root, cast([entity({ images: ['heroes/кадр & 1.png'] })]), null)).toThrowError(
      'Герой «А» & Б: нет файла source/heroes/кадр & 1.png.'
    );
  });

  it('оставляет резервный словарь и мир сохраняемыми данными проекта', () => {
    const root = project();
    const built = castFromSources(manifest(), null, loadDefaults(null));
    const saved = writeCast(root, built, null);
    expect(saved.entities[0]).toEqual({
      id: 'world',
      kind: 'world',
      name: 'Мир сцены',
      short_name: 'Мир',
      role: 'Общие условия: время, погода и окружение',
      appearance: '',
      images: [],
      initial_state: {}
    });
    expect(saved.properties.prop).toEqual([
      { key: 'position', label: 'Положение', hint: 'Где находится и относительно чего', checklist: 'Положение: {value}?' },
      { key: 'condition', label: 'Состояние', hint: 'Внешний вид и изменения по сюжету', checklist: 'Состояние: {value}?' },
      {
        key: 'marks',
        label: 'Сквозные метки',
        hint: 'Детали, которые должны повторяться дальше, с указанием сцены',
        checklist: 'Сквозные метки на месте: {value}?'
      },
      { key: 'note', label: 'Заметка', hint: 'Прочее' }
    ]);
    expect(JSON.parse(readFileSync(join(root, 'plan', 'cast.json'), 'utf-8'))).toEqual(saved);
  });
});
