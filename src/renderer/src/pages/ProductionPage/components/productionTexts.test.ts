/** Независимые ожидания охраняют целые фразы, пустые JSX-значения и согласования после переноса текстов. */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { PackageView } from '@shared/types';
import { productionTexts } from '@shared/texts/production';
import { productionInputLabel, SCENE_CHANGED } from '@shared/production-labels';
import { derivedShotReason, proposalAttention } from '@shared/production-workflow';
import { linkSegments } from '../../../components/linkTargets';
import { DerivedShotNotice } from './DerivedShotNotice';
import { PackageCard } from './PackageCard';
import { PackageKeyframes } from './PackageKeyframes';
import { SendRequestDialog } from './SendRequestDialog';

vi.mock('../../../state', () => ({ useApp: () => ({ aiAccess: null, describeError: String }) }));
vi.mock('../useRequestQuote', () => ({
  useRequestQuote: () => ({ quote: null, error: null, loading: false, refreshQuote: vi.fn(), consumeQuote: vi.fn() })
}));
// Портал скрывает содержимое в SSR; подмена сохраняет тело и контракт кнопки подтверждения.
vi.mock('../../../components/ConfirmationDialog', () => ({
  ConfirmationDialog: ({
    children,
    title,
    confirmLabel,
    confirmDisabled
  }: {
    children: ReactNode;
    title: ReactNode;
    confirmLabel: string;
    confirmDisabled: boolean;
  }) => createElement('section', null, title, children, createElement('button', { disabled: confirmDisabled }, confirmLabel))
}));

const unchanged = (): void => {};
const fixture = (): PackageView => ({
  dir: '/fixture/package',
  relative: 'plan/batches/M01',
  shot: 'M01',
  stage: 'description_review',
  stageLabel: 'Описание на проверке',
  waitReason: null,
  mode: null,
  retryOf: null,
  batch: null,
  timing: null,
  keyframes: [],
  keyframeNotes: [],
  sceneChanged: false,
  description: null,
  prompt: null,
  request: null,
  pendingDecision: null,
  decision: null,
  preview: [],
  problems: []
});

it.each([
  [0, 'Очередь (0)', 'принято 0 из 23', '0,00 с'],
  [1, 'Очередь (1)', 'принято 1 из 23', '1,00 с'],
  [2, 'Очередь (2)', 'принято 2 из 23', '2,00 с'],
  [5, 'Очередь (5)', 'принято 5 из 23', '5,00 с'],
  [11, 'Очередь (11)', 'принято 11 из 23', '11,00 с'],
  [21, 'Очередь (21)', 'принято 21 из 23', '21,00 с'],
  [-2, 'Очередь (-2)', 'принято -2 из 23', '-2,00 с'],
  [1.5, 'Очередь (1.5)', 'принято 1.5 из 23', '1,50 с']
] as const)('сохраняет прежнюю запись счётчиков и секунд для %s', (count, queue, accepted, seconds) => {
  expect(productionTexts.productionQueue.heading({ count })).toBe(queue);
  expect(productionTexts.productionToolbar.accepted({ completed: count, total: 23 })).toBe(accepted);
  expect(productionTexts.productionSpeechPanel.seconds(count)).toBe(seconds);
});

it('сохраняет сообщение об опорах без timing и с длительностью запроса', () => {
  expect(productionTexts.packageKeyframes.heading({ approved: 1, frames: 3 })).toBe('Опоры · утверждено 1 из 3');
  expect(productionTexts.packageKeyframes.heading({ approved: 1, frames: 3, requestSeconds: 0 })).toBe('Опоры · утверждено 1 из 3');
  expect(productionTexts.packageKeyframes.heading({ approved: 1, frames: 3, requestSeconds: 5, windowSeconds: 4.5 })).toBe(
    'Опоры · утверждено 1 из 3 · запрос 5 с на окно 4.5 с'
  );
  const pkg = fixture();
  pkg.keyframes = [{ id: 'K01', role: 'first', time_seconds: 0, approved: false, imagePath: null }];
  const html = renderToStaticMarkup(createElement(PackageKeyframes, { pkg, busy: false, onReopen: unchanged, onSetNote: unchanged }));
  expect(html).toContain('Опоры · утверждено 0 из 1');
  expect(html).not.toContain('undefined');
});

it('сохраняет предупреждение о платном удалении целиком и не добавляет его бесплатной попытке', () => {
  expect(productionTexts.packageCard.discardFolder({ relative: 'plan/пакет «A&B»', paid: true })).toBe(
    'Папка plan/пакет «A&B» будет удалена безвозвратно вместе с запросом, опорами и промптом, включая оплаченный оригинал генерации: кредиты не возвращаются. Принятый комплект сцены и исходники не затрагиваются; после удаления снова доступны новая подготовка и «Подготовить повтор».'
  );
  expect(productionTexts.packageCard.discardFolder({ relative: 'plan/free', paid: false })).toBe(
    'Папка plan/free будет удалена безвозвратно вместе с запросом, опорами и промптом. Принятый комплект сцены и исходники не затрагиваются; после удаления снова доступны новая подготовка и «Подготовить повтор».'
  );
});

it('описывает отдельное подтверждение промпта, неизвестной цены и одной платной попытки', () => {
  expect(productionTexts.sendRequestDialog.description).toBe(
    'Проверьте промпт и материалы перед отправкой платного запроса. Подтверждение разрешает одну попытку генерации.'
  );
  expect(productionTexts.sendRequestDialog.unknownBalance).toBe('Стоимость неизвестна: нажмите «Я согласен», чтобы разрешить один запрос.');
  expect(productionTexts.sendRequestDialog.paymentDescription({ providerTitle: 'Сервис «A&B»' })).toBe(
    'Это платная операция: будут списаны кредиты аккаунта Сервис «A&B». Запрос отправляется ровно один раз, затем приложение ждёт результат и запишет его в пакет.'
  );
  expect(
    productionTexts.sendRequestDialog.requestSummary({
      shot: 'M01',
      image: true,
      frameId: 'K02',
      provider: 'test',
      command: 'text_to_image',
      model: 'model<&>'
    })
  ).toBe('План M01, опора K02, провайдер test, команда text_to_image, модель model<&>.');
  expect(
    productionTexts.sendRequestDialog.requestSummary({ shot: 'M01', image: false, frameId: undefined, provider: undefined, command: undefined, model: 'model' })
  ).toBe('План M01, провайдер не указан, модель model.');
});

it('не печатает null вместо отсутствующего JSX-хеша в подтверждении и сохраняет безопасный вывод', () => {
  const pkg = fixture();
  pkg.request = {
    dir: '/fixture/request',
    kind: 'video',
    sha256: null,
    model: '<script>',
    parameters: {},
    inputs: [],
    attemptStatus: 'prepared',
    generationId: null,
    creditsConsumed: null,
    manualResult: false,
    downloads: []
  };
  const html = renderToStaticMarkup(createElement(SendRequestDialog, { project: '/fixture', pkg, busy: false, onClose: unchanged, onConfirm: async () => {} }));
  expect(html).toContain('Хеш запроса (SHA-256): </span>');
  expect(html).not.toContain('Хеш запроса (SHA-256): null');
  expect(html).toContain('План M01, провайдер не указан, модель &lt;script&gt;.');
  expect(html).toContain('Отправить и списать кредиты');
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).not.toContain('<script>');
});

it.each([null, undefined])('не печатает отсутствующий вердикт %s в последнем ответе пакета', (verdict) => {
  const pkg = fixture();
  pkg.decision = { stage: 'description_review', verdict: verdict as string | null };
  const html = renderToStaticMarkup(
    createElement(PackageCard, {
      pkg,
      busy: false,
      providers: {},
      note: '',
      setNote: unchanged,
      onDecide: unchanged,
      onSubmit: unchanged,
      onAccept: unchanged,
      onContactSheet: unchanged,
      onResume: unchanged,
      onAttachResult: unchanged,
      onNotCreated: unchanged,
      onSelectImage: unchanged,
      onReopenFrame: unchanged,
      onKeepForScene: unchanged,
      onSetKeyframeNote: unchanged
    })
  );
  expect(html).toContain('последний ответ: </span>');
  expect(html).not.toContain('последний ответ: null');
  expect(html).not.toContain('последний ответ: undefined');
});

it('сохраняет целую фразу производного плана, ссылку и экранирование имени источника', () => {
  const source = 'M01 & <script>';
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DerivedShotNotice, { source })));
  expect(html).toContain('План собирается из материала ');
  expect(html).toContain('href="/project/production?shot=M01+%26+%3Cscript%3E"');
  expect(html).toContain('M01 &amp; &lt;script&gt;</a>. Соберите предпросмотр по явному рецепту и примите результат.');
  expect(html).not.toContain('<script>');
  const plain = renderToStaticMarkup(createElement(DerivedShotNotice, { source: 'M01' }));
  expect(plain).toContain('План собирается из материала M01. Соберите предпросмотр по явному рецепту и примите результат.');
  expect(plain).not.toContain('<a ');
});

it('сохраняет весь текст возврата опоры и ссылку к текущему плану', () => {
  const text = productionTexts.useProductionPage.frameNoteSaved({ frame: 'K02' });
  expect(text).toBe('Замечание к K02 сохранено. Создайте опору заново кнопкой «Создать K02» в блоке «Подготовка плана».');
  const segments = linkSegments(text);
  expect(segments.map(({ text }) => text).join('')).toBe(text);
  expect(segments.filter(({ target }) => target).map(({ target }) => target)).toHaveLength(1);
  expect(SCENE_CHANGED).toBe(
    'Постановка или унаследованное состояние плана изменились после подготовки пакета: описание, опоры и промпт могут не соответствовать сценарию.'
  );
});

it('сохраняет подписи входов, технические слоты и объяснения предложения', () => {
  expect(productionInputLabel({ role: 'first', slot: 'image_21' })).toBe('Первый кадр (Изображение 21)');
  expect(productionInputLabel({ slot: 'keyframe_2' })).toBe('Ключевой кадр 2');
  expect(productionInputLabel({ slot: 'custom<&>' })).toBe('custom<&>');
  expect(productionInputLabel({})).toBe('Входной материал');
  expect(derivedShotReason('M01 «A&B»')).toBe('План собирается из материала M01 «A&B»: описание, опоры и генерация для него не нужны.');
  expect(proposalAttention({ stage: 'request', status: 'ready', stale: true, packageDir: null })).toBe(
    'предложение агента устарело: отклоните его или подготовьте заново'
  );
  expect(productionTexts.useProductionWorkflow.proposalInvalid({ stage: 'Запрос', message: 'Путь «A&B» отсутствует.' })).toBe(
    'Запрос: результат агента требует исправления. Путь «A&B» отсутствует.'
  );
  expect(productionTexts.useProductionWorkflow.proposalFailed({ stage: 'Запрос', failed: false })).toBe('Запрос: задание агента прервано.');
});

// Длина промпта меняется при каждой правке, включая окончания 11–14 и 21–24.
it.each([
  [0, 'символов'],
  [1, 'символ'],
  [2, 'символа'],
  [5, 'символов'],
  [11, 'символов'],
  [14, 'символов'],
  [21, 'символ'],
  [22, 'символа'],
  [24, 'символа']
] as const)('согласует длину видеопромпта %s', (characters, word) => {
  expect(productionTexts.packageCard.promptTitle({ approved: true, characters })).toBe(`Видеопромпт · принят · ${characters} ${word}`);
  expect(productionTexts.packageCard.promptTitle({ approved: false, characters })).toBe(`Видеопромпт · не принят · ${characters} ${word}`);
});

it.each([
  [1, 'кадр'],
  [2, 'кадра'],
  [30, 'кадров']
] as const)('согласует частоту кадров %s в ошибке границ', (fps, word) => {
  expect(productionTexts.main.package.acceptBoundsInvalid({ fps })).toBe(
    `Границы участка должны быть конечными неотрицательными секундами на сетке ${fps} ${word}/с.`
  );
});
