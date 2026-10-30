/** Публичные ошибки и формат врезки проверяются независимо от значений доменного словаря. */
import { describe, expect, it } from 'vitest';
import type { CastFile, ScenesFile, TreatmentFile } from '@shared/types';
import { scenarioTexts } from '@shared/texts/scenario';
import { buildBrief, normalizeTreatment, resolveStates, validateScenes, validateTreatment } from './scenario';
import { checkReadyScenes, checkScenesShape, proposalDocuments } from './scenario-proposal';

function registry(): ScenesFile {
  return {
    schema_version: 1,
    fps: 30,
    audio: { path: 'source/track.mp3', end_seconds: '1' },
    references: { hero: { name: 'Герой', path: 'source/heroes/hero.png' } },
    visual_direction: 'Тихий двор',
    sequences: [{ id: 'verse', title: 'Куплет', direction: 'Возвращение домой' }],
    scenes: [
      {
        id: 'M01',
        original: 'Строка песни',
        sequence: 'verse',
        start_frame: 0,
        end_frame_exclusive: 30,
        camera: 'Общий план',
        action: 'Герой идёт.',
        continuity: 'Направление сохраняется',
        references: ['hero'],
        lipsync: false,
        card: { primary_reference: 'hero' },
        state_from: null,
        state_changes: {}
      }
    ]
  };
}

function cast(): CastFile {
  return {
    schema_version: 1,
    properties: { hero: [{ key: 'position', label: 'Положение', hint: '', checklist: 'Положение — {value}' }] },
    entities: [
      {
        id: 'hero',
        kind: 'hero',
        name: 'Герой «А»',
        short_name: 'А',
        role: '',
        appearance: '',
        images: ['heroes/hero.png'],
        initial_state: { position: 'у двери' }
      }
    ]
  };
}

describe('контракт текста сценария', () => {
  it('сохраняет кавычки, значения времени и порядок проблем трактовки', () => {
    const treatment: TreatmentFile = {
      schema_version: 1,
      logline: 'Возвращение',
      sequences: [{ id: 'bad/id', title: 'Куплет «А»', direction: '', start: 1.5, end: 1, entities: [], lipsync: false }]
    };
    expect(validateTreatment(treatment, 3)).toEqual([
      'Часть «Куплет «А»»: код латиницей.',
      'Часть bad/id: начало 1.5 не стыкуется с 0.00.',
      'Часть bad/id: конец раньше начала.',
      'Части заканчиваются на 1.00, а трек длится 3.00.'
    ]);
    expect(() => normalizeTreatment({ schema_version: 1, logline: 4, sequences: [] }, null)).toThrow(
      new Error('Трактовка: нужны schema_version 1, logline и sequences.')
    );
  });

  it('сохраняет undefined при диагностике отсутствующего конца песни', () => {
    const data = registry();
    delete (data as Partial<ScenesFile>).audio;
    expect(validateScenes(data, null)).toEqual(['Монтажный конец 1.000 с расходится с концом песни undefined.']);
  });

  it('сохраняет полную цепочку цикла и ошибку отсутствующей сцены', () => {
    const data = registry();
    data.scenes[0].state_from = 'M01';
    expect(() => resolveStates(data, {})).toThrow(new Error('Цикл state_from: M01 → M01'));
    expect(() => buildBrief(registry(), null, 'M99', 'before', null)).toThrow(new Error('M99: сцена отсутствует в реестре.'));
  });

  it.each([
    [null, 'Реестр: неверная структура плана.'],
    [{ id: '' }, 'Реестр, : неверная структура плана.'],
    [{ id: 'M«01»' }, 'Реестр, M«01»: неверная структура плана.']
  ])('сохраняет необязательный ID неверного плана: %j', (scene, expected) => {
    expect(() => checkScenesShape({ ...registry(), scenes: [scene] })).toThrow(new Error(expected));
  });

  it.each([
    [null, 'Реестр, M01: в state_changes допустимы только фазы before и after. Коды сущностей вкладываются в фазы.'],
    [{ hero: {}, stray: {} }, 'Реестр, M01: в state_changes допустимы только фазы before и after, получено: hero, stray. Коды сущностей вкладываются в фазы.'],
    [{ before: null }, 'Реестр, M01: изменения состояния должны быть объектом.']
  ])('различает не-объект, неверные фазы и неверное изменение: %j', (stateChanges, expected) => {
    const data = registry();
    expect(() => checkScenesShape({ ...data, scenes: [{ ...data.scenes[0], state_changes: stateChanges }] })).toThrow(new Error(expected));
  });

  it('сначала отклоняет оболочку предложения, затем её лишние поля', () => {
    const before = { cast: null, treatment: null, scenes: null };
    expect(() => proposalDocuments('{}', 'scenes', before, null, [], 1, null)).toThrow(
      new Error('Нужен один JSON-документ с schemaVersion 1 и ожидаемым pass.')
    );
    expect(() => proposalDocuments('{"schemaVersion":1,"pass":"scenes","extra":true}', 'scenes', before, null, [], 1, null)).toThrow(
      new Error('В ответе есть поля вне контракта предложения.')
    );
  });

  it('сводит незаполненные планы в один пункт перед остальными проблемами', () => {
    const data = registry();
    data.scenes = Array.from({ length: 7 }, (_, index) => ({
      ...data.scenes[0],
      id: `M${String(index + 1).padStart(2, '0')}`,
      start_frame: index * 30,
      end_frame_exclusive: (index + 1) * 30,
      camera: 'ЗАПОЛНИТЬ'
    }));
    data.audio.end_seconds = '7';
    data.visual_direction = '';
    const emptyCast: CastFile = { schema_version: 1, entities: [], properties: {} };
    data.references = {};
    for (const scene of data.scenes) {
      scene.references = [];
      scene.card.primary_reference = '';
    }
    // Главный референс намеренно отсутствует: сводный пункт должен остаться первым в многострочной ошибке.
    expect(() => checkReadyScenes(data, emptyCast, 7)).toThrow(
      new Error(
        'Осталась незаполненная постановка: 7 планов (M01, M02, M03, M04, M05, M06 и другие).\n' +
          'M01: главный референс карточки не объявлен.\n' +
          'M02: главный референс карточки не объявлен.\n' +
          'M03: главный референс карточки не объявлен.\n' +
          'M04: главный референс карточки не объявлен.\n' +
          'M05: главный референс карточки не объявлен.\n' +
          'M06: главный референс карточки не объявлен.\n' +
          'M07: главный референс карточки не объявлен.\n' +
          'Заполните общую визуальную постановку.'
      )
    );
  });

  it.each([
    [0, 'Осталась незаполненная постановка: 0 планов (M01).'],
    [1, 'Осталась незаполненная постановка: 1 план (M01).'],
    [2, 'Осталась незаполненная постановка: 2 плана (M01).'],
    [5, 'Осталась незаполненная постановка: 5 планов (M01).'],
    [11, 'Осталась незаполненная постановка: 11 планов (M01 и другие).'],
    [21, 'Осталась незаполненная постановка: 21 план (M01 и другие).'],
    [-2, 'Осталась незаполненная постановка: -2 плана (M01).'],
    [1.5, 'Осталась незаполненная постановка: 1.5 плана (M01).']
  ])('сохраняет прежнее согласование количества %s', (count, expected) => {
    expect(scenarioTexts.main.unfilledShots({ count, ids: ['M01'] })).toBe(expected);
  });

  it.each([
    ['before', 'Состояние на первый кадр'],
    ['after', 'Состояние на последний кадр']
  ] as const)('сохраняет формат пустой врезки для %s', (phase, title) => {
    const result = buildBrief(registry(), null, 'M01', phase, null);
    expect(result.paragraph).toBe(`${title} M01: состояние не задано.`);
    expect(result.text).toBe(`${title} M01 (Герой идёт.)\n\nСостояние не задано: в кастинге нет начального состояния, а в сценах нет изменений.`);
    expect(result.text.split('\n')).toHaveLength(3);
    expect(result.text.split('\n')[1]).toBe('');
    expect(result.text.split('\n').slice(2)).toEqual(['Состояние не задано: в кастинге нет начального состояния, а в сценах нет изменений.']);
    expect(result.checklist).toEqual([]);
  });

  it('сохраняет описания и Markdown-чеклист после двух строк заголовка', () => {
    const result = buildBrief(registry(), cast(), 'M01', 'before', null);
    expect(result.paragraph).toBe('Состояние на первый кадр M01. Герой «А»: положение: у двери.');
    expect(result.checklist).toEqual(['Герой «А»: Положение — у двери']);
    expect(result.text).toBe(
      'Состояние на первый кадр M01 (Герой идёт.)\n\nГерой «А»: положение: у двери.\n\nПроверить по кадру:\n- [ ] Герой «А»: Положение — у двери'
    );
    expect(result.text.split('\n')).toHaveLength(6);
    expect(result.text.split('\n').slice(2)).toEqual(['Герой «А»: положение: у двери.', '', 'Проверить по кадру:', '- [ ] Герой «А»: Положение — у двери']);
  });
});
