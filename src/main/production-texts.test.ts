/** Независимые ожидания фиксируют целые публичные сообщения, спецсимволы и границы проверок без вызова генераторов. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { productionTexts } from '@shared/texts/production';
import { Production, readPackage, viewProduction } from './production';
import { requireProductionPackageAccess } from './production-access';
import { checkDuration, checkFrameCandidates, productionPath } from './production-proposal';
import { applyProductionPackage } from './production-workflow-apply';
import { speechPlan } from './speech';
import { writableProductionStatus } from './shot-acceptance';

const texts = productionTexts.main;
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-production-texts-'));
  mkdirSync(join(project, 'plan/batches/Пакет «M01»'), { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

describe('фразы производства', () => {
  it('сохраняет пути и вложенные кавычки в целых сообщениях', () => {
    const path = 'source/План «дубль 2»/кадр $1.png';
    expect(texts.imageRequest.referenceUnavailable({ path })).toBe('Недоступен референс опоры: source/План «дубль 2»/кадр $1.png');
    expect(texts.proposal.pathOutsideProject({ path })).toBe('Путь выходит из проекта: source/План «дубль 2»/кадр $1.png');
    expect(texts.package.folderUsedByMontageDraft({ draft: 'Ночь «дубль 2» $1' })).toBe(
      'Папка используется сохранённым черновиком монтажа «Ночь «дубль 2» $1». Сначала удалите черновик.'
    );
    expect(texts.images.jobTitle({ shot: 'M01.2', frames: 'K01, K02', provider: 'Тест «A»' })).toBe('Опоры M01.2: K01, K02 · Тест «A»');
    expect(texts.apply.applyRecoveryFailed({ error: 'Error: файл «a»', restoreError: 'Error: путь C:\\Пакет\\b' })).toBe(
      'Применение прервано: Error: файл «a». Восстановление не завершено: Error: путь C:\\Пакет\\b. Резерв сохранён.'
    );
  });

  it('сохраняет различие пустого, отсутствующего и неизвестного значения в предупреждениях', () => {
    expect(texts.package.adapterMissing({ provider: '' })).toBe('Для провайдера  не подключён исполнитель.');
    expect(texts.package.adapterMissing({ provider: null })).toBe('Для провайдера не указан не подключён исполнитель.');
    expect(texts.package.adapterMissing({ provider: undefined })).toBe('Для провайдера не указан не подключён исполнитель.');
    expect(texts.package.attentionQuestion({ name: 'M01', question: '' })).toBe('M01: вопрос ждёт ответа');
    expect(texts.package.attentionQuestion({ name: 'M01', question: 'Принять «K01»?' })).toBe('M01: Принять «K01»?');
    expect(texts.workflow.providerModelsFailed({ provider: undefined, problem: '' })).toBe(
      'Не удалось получить актуальные модели провайдера видео: нет объявлений аккаунта'
    );
    expect(texts.workflow.providerModelsFailed({ provider: '', problem: 'Текст «ошибки»' })).toBe('Не удалось получить актуальные модели : Текст «ошибки»');
  });

  it('сохраняет заголовки заданий и необязательное копирование медиа', () => {
    expect(texts.package.submitImageJob({ frame: 'K02' })).toBe('Отправка опоры K02');
    expect(texts.package.submitImageJob({ frame: undefined })).toBe('Отправка опоры undefined');
    expect(texts.package.submitJob({ shot: 'M01' })).toBe('Отправка M01');
    expect(texts.package.bundleJob({ copy: undefined })).toBe('Пакет для монтажёра');
    expect(texts.package.bundleJob({ copy: false })).toBe('Пакет для монтажёра');
    expect(texts.package.bundleJob({ copy: true })).toBe('Пакет для монтажёра с медиа');
    expect(texts.workflow.toolExitCode({ tool: 'shot_workflow', code: null })).toBe('shot_workflow: код null');
  });

  it.each([
    [0, 'Длительность 0 с нарушает правило exact_window для окна 30 с.'],
    [1, 'Длительность 1 с нарушает правило exact_window для окна 30 с.'],
    [2, 'Длительность 2 с нарушает правило exact_window для окна 30 с.'],
    [5, 'Длительность 5 с нарушает правило exact_window для окна 30 с.'],
    [11, 'Длительность 11 с нарушает правило exact_window для окна 30 с.'],
    [21, 'Длительность 21 с нарушает правило exact_window для окна 30 с.'],
    [-2, 'Длительность -2 с нарушает правило exact_window для окна 30 с.'],
    [1.5, 'Длительность 1.5 с нарушает правило exact_window для окна 30 с.']
  ])('передаёт число %s без исправления исходной грамматики', (seconds, expected) => {
    expect(texts.proposal.durationRuleViolation({ seconds: Number(seconds), rule: 'exact_window', window: 30 })).toBe(expected);
  });
});

describe('публичные проверки производства', () => {
  it.each([0, -2, 1.5, NaN, Infinity])('сохраняет первую ошибку для недопустимой длительности %s', (seconds) => {
    expect(() => checkDuration(seconds, 1, 'exact_window')).toThrowError(new Error('Длительность запроса должна быть положительным целым числом секунд.'));
  });

  it.each([
    [1, 'Длительность 1 с нарушает правило exact_window для окна 30 с.'],
    [2, 'Длительность 2 с нарушает правило exact_window для окна 30 с.'],
    [5, 'Длительность 5 с нарушает правило exact_window для окна 30 с.'],
    [11, 'Длительность 11 с нарушает правило exact_window для окна 30 с.'],
    [21, 'Длительность 21 с нарушает правило exact_window для окна 30 с.']
  ])('ошибка правила сохраняет число %s', (seconds, expected) => {
    expect(() => checkDuration(Number(seconds), 30, 'exact_window')).toThrowError(new Error(String(expected)));
  });

  it('проверяет путь раньше чтения файла и сохраняет исходную запись пользователя', () => {
    expect(() => productionPath(project, '../Чужой «план»/кадр $1.png')).toThrowError(new Error('Путь выходит из проекта: ../Чужой «план»/кадр $1.png'));
    const outside = join(project, '..');
    symlinkSync(outside, join(project, 'ссылка'));
    expect(() => productionPath(project, 'ссылка/кадр.png')).toThrowError(new Error('Ссылка ведёт за пределы проекта: ссылка/кадр.png'));
    expect(() => checkFrameCandidates([], [])).toThrowError(new Error('Добавьте изображение хотя бы для одной опоры.'));
  });

  it('возвращает дословные проблемы пакета и состояния без чтения провайдеров', () => {
    const dir = join(project, 'plan/batches/Пакет «M01»');
    writeJson(join(dir, 'workflow.json'), { shot: 'M01', stage: 'image_request_choice', image_request_dir: 'request' });
    expect(readPackage(project, dir)).toMatchObject({ stageLabel: 'запрос изображения на подтверждении', problems: ['В папке запроса нет request.json.'] });
    expect(viewProduction(project).problems).toEqual(['Сначала нужен сценарий. Создайте его на странице «Сценарий».']);
  });

  it('не вызывает проверку исполнителя до валидации сохранённого запроса', async () => {
    const dir = join(project, 'plan/batches/Пакет «M01»');
    writeJson(join(dir, 'workflow.json'), { shot: 'M01', stage: 'request_choice', request_dir: 'request' });
    const access = vi.fn(async () => {});
    await expect(requireProductionPackageAccess(project, dir, access)).rejects.toThrowError(new Error('В пакете нет сохранённого запроса.'));
    mkdirSync(join(dir, 'request'));
    writeJson(join(dir, 'request/request.json'), { model: 'test', parameters: {}, inputs: [] });
    await expect(requireProductionPackageAccess(project, dir, access)).rejects.toThrowError(new Error('В сохранённом запросе не указан провайдер.'));
    expect(access).not.toHaveBeenCalled();
  });

  it('проверяет папку применения раньше вызова замены и оставляет файлы прежними', async () => {
    const apply = vi.fn(async () => {});
    await expect(applyProductionPackage(join(project, 'local'), project, 'plan/batches', apply)).rejects.toThrowError(
      new Error('Нужен отдельный рабочий пакет внутри plan/batches или plan/awaiting.')
    );
    expect(apply).not.toHaveBeenCalled();
    const path = join(project, 'plan/production-status.json');
    writeFileSync(path, '{');
    expect(() => writableProductionStatus(project)).toThrowError(
      new Error('plan/production-status.json повреждён: исправьте файл, чтобы записать принятые отпечатки.')
    );
    expect(readFileSync(path, 'utf8')).toBe('{');
  });

  it('сохраняет сообщения чтения реестра речи и идентификатор отсутствующего плана', () => {
    expect(() => speechPlan(project, 'M05')).toThrowError(new Error('Не удалось прочитать реестр сцен.'));
    writeJson(join(project, 'plan/scenes.json'), { fps: 30, scenes: [] });
    expect(() => speechPlan(project, 'M05')).toThrowError(new Error('M05: план отсутствует в реестре сцен.'));
  });

  it('останавливает submit без оценки стоимости до запуска задания', async () => {
    const start = vi.fn();
    const production = new Production(null, { get: () => undefined, start } as never);
    await expect(production.submit(project, 'plan/batches/Пакет «M01»', 'a'.repeat(64), undefined)).rejects.toThrowError(
      new Error('Сначала откройте запрос и подтвердите актуальную стоимость.')
    );
    expect(start).not.toHaveBeenCalled();
  });
});
