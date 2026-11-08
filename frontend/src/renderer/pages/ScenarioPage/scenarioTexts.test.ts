import { describe, expect, it } from 'vitest';
import { scenarioTexts } from '@shared/texts/scenario';

// Целые результаты независимы от словаря: в том числе старые склонения и числа за обычными границами счётчиков.
describe('Тексты сценария с числами', () => {
  it.each([
    [0, 'свойств', 'кадров'],
    [1, 'свойство', 'кадр'],
    [2, 'свойства', 'кадра'],
    [5, 'свойств', 'кадров'],
    [11, 'свойств', 'кадров'],
    [21, 'свойство', 'кадр'],
    [-2, 'свойства', 'кадра'],
    [1.5, 'свойства', 'кадра']
  ])('сохраняет фразы и единицы для %s', (count, properties, frames) => {
    expect(scenarioTexts.brief.changes({ count })).toBe(`Изменений за план: ${count}`);
    expect(scenarioTexts.brief.entityChanges({ changes: count, hidden: count })).toBe(
      count ? `изменений: ${count} · скрыто без изменений: ${count} ${properties}` : 'без изменений за план'
    );
    expect(scenarioTexts.delta.partialChanges({ changing: count, total: 21 })).toBe(`изменений: ${count} из 21`);
    expect(scenarioTexts.delta.changes({ count })).toBe(`изменений: ${count}`);
    expect(scenarioTexts.delta.changeSummary({ total: 21, changing: count, same: count })).toBe(
      `Задано свойств в этом блоке: 21; отличаются от унаследованного: ${count}.${count ? ` Совпадают с унаследованным и ничего не меняют: ${count} — их можно убрать.` : ''}`
    );
    expect(scenarioTexts.comparison.changedFields({ count })).toBe(`изменено полей: ${count}`);
    expect(scenarioTexts.toolbar.fixRegistry({ count })).toBe(`Исправьте проблемы реестра: ${count}.`);
    expect(scenarioTexts.toolbar.treatmentTab({ count })).toBe(`Трактовка · ${count}`);
    expect(scenarioTexts.toolbar.scenesTab({ count })).toBe(`Реестр сцен · ${count}`);
    expect(scenarioTexts.toolbar.problems({ count })).toBe(`Проблем: ${count}`);
    expect(scenarioTexts.workflow.showAllProblems({ count })).toBe(`Показать все (${count})`);
    expect(scenarioTexts.list.foundShots({ shown: count, total: 21 })).toBe(`Найдено планов: ${count} из 21`);
    expect(scenarioTexts.list.shots({ count })).toBe(`Планов: ${count}`);
    expect(scenarioTexts.registry.moreProblems({ count })).toBe(`… и ещё ${count}`);
    expect(scenarioTexts.shot.timing({ start: '00:01.00', end: '00:02.50', seconds: '1.50', frames: count })).toBe(
      `00:01.00–00:02.50 · 1.50 с · ${count} ${frames}`
    );
    expect(scenarioTexts.timeline.statusCount({ label: 'Принят', count })).toBe(`Принят: ${count}`);
    expect(scenarioTexts.save.affectedShots({ count })).toBe(`Затронутые планы: ${count}`);
  });

  it('различает отсутствие реестра, нулевой счётчик и прежнее строковое undefined', () => {
    expect(scenarioTexts.toolbar.treatmentTab({ count: null })).toBe('Трактовка');
    expect(scenarioTexts.toolbar.scenesTab({ count: null })).toBe('Реестр сцен');
    expect(scenarioTexts.timeline.statusCount({ label: 'Запланирован', count: undefined })).toBe('Запланирован: undefined');
    expect(scenarioTexts.brief.entityChanges({ changes: 0, hidden: 2 })).toBe('без изменений за план · скрыто без изменений: 2 свойства');
  });
});

describe('Параметры, ветвления и полные фразы сценария', () => {
  it.each([
    [false, false, 'Изменены: .'],
    [true, false, 'Изменены: трактовка.'],
    [false, true, 'Изменены: реестр сцен.'],
    [true, true, 'Изменены: трактовка, реестр сцен.']
  ])('сохраняет флаги черновиков %s / %s', (treatment, scenes, expected) => {
    expect(scenarioTexts.drafts.changed({ treatment, scenes })).toBe(expected);
  });

  it.each([
    [false, false, 'hero', 'Часть hero'],
    [true, false, 'hero · новая сущность', 'Часть hero · новая'],
    [false, true, 'hero · удаление', 'Часть hero · удаление'],
    [true, true, 'hero · новая сущность', 'Часть hero · новая']
  ])('сохраняет приоритет добавления/удаления %s / %s', (added, removed, entity, part) => {
    expect(scenarioTexts.comparison.entityTitle({ id: 'hero', added, removed })).toBe(entity);
    expect(scenarioTexts.comparison.partTitle({ id: 'hero', added, removed })).toBe(part);
  });

  it('сохраняет кавычки, спецсимволы, путь и разделители параметров', () => {
    const id = 'M<&>"/C:\\клип';
    expect(scenarioTexts.brief.planSource({ shot: id, phase: 'before' })).toBe('M<&>"/C:\\клип · первый кадр');
    expect(scenarioTexts.brief.planSource({ shot: id, phase: 'after' })).toBe('M<&>"/C:\\клип · итог');
    expect(scenarioTexts.brief.firstShotFrame({ shot: id })).toBe('Первый кадр M<&>"/C:\\клип');
    expect(scenarioTexts.brief.lastShotFrame({ shot: id })).toBe('Последний кадр M<&>"/C:\\клип');
    expect(scenarioTexts.brief.propertyCode({ key: id })).toBe('Код свойства: M<&>"/C:\\клип');
    expect(scenarioTexts.brief.openCastState({ name: id })).toBe('Открыть начальное состояние «M<&>"/C:\\клип» на странице «Кастинг»');
    expect(scenarioTexts.brief.scrollCurrentState({ block: '«Первый кадр (before)»' })).toBe(
      'Прокрутить к блоку «Состояние героев и мира» этого плана: значение задано в «Первый кадр (before)»'
    );
    expect(scenarioTexts.brief.openShotState({ shot: id, block: '«Итог плана (after)»' })).toBe(
      'Открыть план M<&>"/C:\\клип и его блок «Состояние героев и мира»: значение задано в «Итог плана (after)»'
    );
    expect(scenarioTexts.comparison.imagesMissing({ name: id })).toBe('M<&>"/C:\\клип: изображения отсутствуют. Референс ещё нужно подготовить.');
    expect(scenarioTexts.comparison.changedField({ label: id })).toBe('изменено: M<&>"/C:\\клип');
    expect(scenarioTexts.comparison.stateBefore({ shot: id })).toBe('Состояние перед M<&>"/C:\\клип');
    expect(scenarioTexts.comparison.shotTitle({ id, changed: false })).toBe('План M<&>"/C:\\клип');
    expect(scenarioTexts.comparison.shotTitle({ id, changed: true })).toBe('План M<&>"/C:\\клип · изменён');
    expect(scenarioTexts.delta.removeEntity({ name: id })).toBe('Удалить изменения сущности «M<&>"/C:\\клип»');
    expect(scenarioTexts.proposal.scenarioTitle({ pass: id })).toBe('Предложение для сценария · M<&>"/C:\\клип');
    expect(scenarioTexts.proposal.agentTitle({ pass: id })).toBe('Предложение агента · M<&>"/C:\\клип');
    expect(scenarioTexts.proposal.changedShots({ ids: [id, 'M02'] })).toBe('Изменённые планы: M<&>"/C:\\клип, M02');
    expect(scenarioTexts.state.after({ shot: id })).toBe('после M<&>"/C:\\клип');
    expect(scenarioTexts.state.before({ shot: id })).toBe('перед M<&>"/C:\\клип');
    expect(scenarioTexts.state.repeat({ shot: id })).toBe('повтор M<&>"/C:\\клип');
    expect(scenarioTexts.timeline.range({ start: '01:02.00', end: '01:03.50' })).toBe('01:02.00–01:03.50');
    expect(scenarioTexts.timeline.shotHint({ id, start: '01:02.00', end: '01:03.50', status: null })).toBe('M<&>"/C:\\клип · 01:02.00–01:03.50');
    expect(scenarioTexts.timeline.shotHint({ id, start: '01:02.00', end: '01:03.50', status: 'Принят' })).toBe('M<&>"/C:\\клип · 01:02.00–01:03.50 · Принят');
  });

  it('сохраняет пустые списки и целое предупреждение о доработке', () => {
    expect(scenarioTexts.proposal.changedShots({ ids: [] })).toBe('Изменённые планы: нет');
    expect(scenarioTexts.revise.context({ ids: [] })).toBe('Планы: не выбраны. Соседние планы используются как контекст; их постановка не меняется.');
    expect(scenarioTexts.revise.context({ ids: ['M01', 'M<&>'] })).toBe(
      'Планы: M01, M<&>. Соседние планы используются как контекст; их постановка не меняется.'
    );
    expect(scenarioTexts.comparison.allowedTargets({ ids: ['M01', 'M<&>'] })).toBe(
      'Разрешённые цели: M01, M<&>. Изменения состояния могут влиять на наследуемое состояние следующих планов; проверьте непрерывность ниже и в редакторе перед дальнейшим производством.'
    );
  });

  it('сохраняет подпись источника и fallback следующего плана', () => {
    expect(scenarioTexts.shot.sourceOption({ id: 'M01', title: undefined, derived: null })).toBe('M01');
    expect(scenarioTexts.shot.sourceOption({ id: 'M01', title: '', derived: 'M02' })).toBe('M01 (сам из M02)');
    expect(scenarioTexts.shot.sourceOption({ id: 'M01', title: '<&>', derived: 'M02' })).toBe('M01 · <&> (сам из M02)');
    expect(scenarioTexts.shot.sourceOption({ id: 'M01', title: '<&>', derived: '' })).toBe('M01 · <&> (сам из )');
    expect(scenarioTexts.shot.mergeDescription({ shot: 'M01', next: undefined })).toBe(
      'Планы M01 и следующий станут одним. Камера и действие останутся от M01; отдельная запись следующего плана будет удалена. Изменение применяется к черновику.'
    );
    expect(scenarioTexts.shot.mergeDescription({ shot: 'M<&>', next: 'M02' })).toBe(
      'Планы M<&> и M02 станут одним. Камера и действие останутся от M<&>; отдельная запись следующего плана будет удалена. Изменение применяется к черновику.'
    );
    expect(scenarioTexts.treatment.deletePart({ title: '<&>', id: 'intro' })).toBe('Удалить часть трактовки «<&>»');
    expect(scenarioTexts.treatment.deletePart({ title: '', id: 'intro' })).toBe('Удалить часть трактовки «intro»');
    expect(scenarioTexts.treatment.deletePart({ title: '', id: '' })).toBe('Удалить часть трактовки «без названия»');
  });

  it('сохраняет оба полных предупреждения сохранения и пробел перед примечанием об аниматике', () => {
    expect(scenarioTexts.save.productionDescription()).toBe(
      'Сохранение меняет постановку планов ниже. Принятые из них получат статус «постановка изменена» и потребуют нового производства, а их пакеты — нового согласования. Если правка не меняет сюжет, например исправляет опечатку, выберите «Сохранить без производства». Аниматик после сохранения потребует пересборки — это локальная операция без оплаты.'
    );
    expect(scenarioTexts.save.keepDescription()).toBe(
      'Подходит для опечаток и правок, не меняющих сюжет. Принятые комплекты и пакеты перечисленных планов останутся в силе, хотя их постановка в реестре изменится. Аниматик после сохранения потребует пересборки — это локальная операция без оплаты.'
    );
  });
});
