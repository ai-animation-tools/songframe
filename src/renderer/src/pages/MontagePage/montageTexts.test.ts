import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { montageTexts } from '@shared/texts/montage';
import type { MontageClip, MontageDraft, MontageSource, MontageView } from '@shared/montage';
import { MontageClipEditor } from './components/MontageClipEditor';
import { MontageApplyDialog } from './components/MontageApplyDialog';
import { materialLabel, materialColor } from './components/MontageMaterialChip';
import { LinkedText } from '../../components/LinkedText';

// Portal не рендерится сервером; сохраняем настоящих детей диалога и проверяем вычисление границ страницей.
vi.mock('../../components/ConfirmationDialog', () => ({
  ConfirmationDialog: ({ title, children }: { title: ReactNode; children: ReactNode }) => createElement('section', null, title, children)
}));

const noop = (): void => {};
const textContent = (html: string): string =>
  html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const clip: MontageClip = {
  id: 'M1',
  scene: 'M1',
  path: 'assets/<роль>&".mp4',
  kind: 'video',
  source_start_frame: 90,
  source_end_frame_exclusive: 120,
  source_frames: null
};
const draft: MontageDraft = {
  schema_version: 1,
  name: 'Проба',
  clips: [clip],
  audio: { path: 'source/song.wav', start_frame: 0, end_frame_exclusive: 30 },
  base_scenes_sha256: '',
  base_manifest_sha256: {}
};

// Ожидания самостоятельны: проверяем прежнюю грамматику, знаки и точные целые/дробные числа.
describe('Тексты ручного монтажа', () => {
  it.each([
    [0, '0 кадров'],
    [1, '1 кадр'],
    [2, '2 кадра'],
    [5, '5 кадров'],
    [11, '11 кадров'],
    [21, '21 кадр'],
    [-2, '-2 кадра'],
    [1.5, '1.5 кадра']
  ])('сохраняет форматы для %s кадров', (value, expected) => {
    expect(montageTexts.lengthsMatch(value)).toBe(`Музыкальный участок и видео совпадают: ${expected}.`);
    expect(montageTexts.sourceRange({ start: '00:03:00', end: '00:04:00', frames: value })).toBe(`В исходнике: 00:03:00 — 00:04:00 · ${expected}`);
    expect(montageTexts.cardClipLength(value)).toBe(`${value} к · опора`);
    expect(montageTexts.videoClipLength(value)).toBe(`${value} к · видео`);
    expect(montageTexts.scaleValue(value)).toBe(`${value} px/с`);
    expect(montageTexts.volumeValue(value)).toBe(`${value}%`);
    expect(montageTexts.panelHeight(value)).toBe(`Высота верхней панели ${value} пикселей`);
    expect(montageTexts.materialPosition({ position: value, total: 21 })).toBe(`Материал ${value} из 21`);
    expect(montageTexts.availableScenes({ available: value, total: 21 })).toBe(`Доступно ${value} из 21 сцен`);
    expect(montageTexts.foundScenes({ found: value, total: 21 })).toBe(`Найдено сцен: ${value} из 21`);
    expect(montageTexts.draftStatus({ name: '«<>&»', fps: value })).toBe(`Проба ««<>&»» · ${value} кадров/с`);
  });

  it.each([
    [0, 'Музыка: 0 кадров, видео: 0 кадров. Разница 0 кадров. Выровняйте выделение музыки или обрежьте видео.'],
    [1, 'Музыка: 0 кадров, видео: 1 кадр. Разница +1 кадр. Выровняйте выделение музыки или обрежьте видео.'],
    [2, 'Музыка: 0 кадров, видео: 2 кадра. Разница +2 кадра. Выровняйте выделение музыки или обрежьте видео.'],
    [5, 'Музыка: 0 кадров, видео: 5 кадров. Разница +5 кадров. Выровняйте выделение музыки или обрежьте видео.'],
    [11, 'Музыка: 0 кадров, видео: 11 кадров. Разница +11 кадров. Выровняйте выделение музыки или обрежьте видео.'],
    [21, 'Музыка: 0 кадров, видео: 21 кадр. Разница +21 кадр. Выровняйте выделение музыки или обрежьте видео.'],
    [-2, 'Музыка: 0 кадров, видео: -2 кадра. Разница -2 кадра. Выровняйте выделение музыки или обрежьте видео.'],
    [1.5, 'Музыка: 0 кадров, видео: 1.5 кадра. Разница +1.5 кадра. Выровняйте выделение музыки или обрежьте видео.']
  ])('сохраняет полное сообщение о несовпадении при %s', (length, expected) => {
    expect(montageTexts.lengthMismatch({ audioLength: 0, length })).toBe(expected);
  });

  it('сохраняет специальные символы, пути и необязательные значения без нового fallback', () => {
    expect(montageTexts.removeDescription(undefined)).toBe('Фрагмент сцены «undefined» будет удалён из монтажа. Исходный файл сохранится.');
    expect(montageTexts.removeDescription('M<&>')).toBe('Фрагмент сцены «M<&>» будет удалён из монтажа. Исходный файл сохранится.');
    expect(montageTexts.videoSaved('C:\\Проект\\<>&".mp4')).toBe('Проба сохранена: C:\\Проект\\<>&".mp4');
    expect(montageTexts.videoOpenFailed({ scene: 'M<&>', path: 'assets/<>&.mp4' })).toBe('Не удалось открыть видео M<&>: assets/<>&.mp4');
    expect(montageTexts.playerWindowFailed('<>&')).toBe('Не удалось открыть или закрыть окно плеера: <>&');
    expect(montageTexts.exportFailed('<>&')).toBe('Экспорт MP4 не выполнен. <>&');
    expect(montageTexts.applyFailed('<>&')).toBe('Применение к сценам не выполнено. <>&');
    expect(montageTexts.waveFailed('<>&')).toBe('Волна недоступна: <>&');
    expect(montageTexts.waveWarning('Волна недоступна: <>&')).toBe('Волна недоступна: <>& Выделение и прослушивание остаются доступны.');
    expect(montageTexts.sceneTitle({ scene: 'M<&>', title: '«Опора»' })).toBe('M<&> — «Опора»');
    expect(montageTexts.sourceLabel({ title: 'M<&> — «Опора»', label: '<>&' })).toBe('M<&> — «Опора»: <>&');
    expect(montageTexts.openMaterial('<>&')).toBe('Открыть материал: <>&');
    expect(montageTexts.lyricTitle({ time: '00:03:00', text: '<>&' })).toBe('00:03:00 — <>&');
    expect(montageTexts.selectedScene('M<&>')).toBe('Выбранная сцена · M<&>');
    expect(montageTexts.selectScene('M<&>')).toBe('Выбрать сцену M<&>');
    expect(montageTexts.scenarioDuration('00:03:00')).toBe('По сценарию: 00:03:00');
    expect(montageTexts.audioRange({ start: '00:03:00', end: '00:04:00' })).toBe(
      'Участок песни: 00:03:00 — 00:04:00. Положение на обеих дорожках считается от начала исходной песни.'
    );
    expect(montageTexts.sharedCut({ scene: 'M<&>', next: 'M2' })).toBe(
      'Общий стык M<&> → M2: кадры переходят от одного плана другому, длина монтажа сохраняется.'
    );
    expect(montageTexts.showExportProblem('<>&')).toBe('<>& Нажмите, чтобы показать сведения под дорожкой.');
    expect(montageTexts.playbackPosition({ position: '00:03:00', length: '00:04:00', scene: undefined })).toBe('00:03:00 / 00:04:00 · —');
    expect(montageTexts.playbackPosition({ position: '00:03:00', length: '00:04:00', scene: null })).toBe('00:03:00 / 00:04:00 · —');
    expect(montageTexts.playbackPosition({ position: '00:03:00', length: '00:04:00', scene: '' })).toBe('00:03:00 / 00:04:00 · ');
    expect(montageTexts.attemptOnTrack({ scene: 'M<&>', label: '«Новый»' })).toBe(
      'На дорожке M<&> стоит ««Новый»»: этот ролик ещё не принят в assets. Принятый клип сцены доступен в материалах справа.'
    );
    expect(montageTexts.replaceDescription({ scene: 'M<&>', label: '«Новый»' })).toBe(
      'На дорожке сцены M<&> текущий вариант будет заменён на ««Новый»». Обрезка начнётся заново с начала выбранного материала; если он короче, фрагмент на дорожке станет короче. Исходные файлы сохранятся, замену можно отменить.'
    );
  });

  it('сохраняет исходную типографику диапазонов и пробел перед прежними границами', () => {
    expect(montageTexts.applyRange({ scene: 'M1', start: '00:00:00', end: '00:01:00' })).toBe('M1: 00:00:00 — 00:01:00');
    expect(montageTexts.applyRange({ scene: 'M1', start: '00:00:00', end: '00:01:00', previous: { start: '00:03:00', end: '00:04:00' } })).toBe(
      'M1: 00:00:00 — 00:01:00 (было 00:03:00 — 00:04:00)'
    );
  });

  it('сохраняет публичные подписи материалов и цвета в renderer', () => {
    const source = { kind: 'video', attempt: false, original: false } as MontageSource;
    expect(materialLabel(source)).toBe('Принятый монтаж');
    expect(materialColor(source)).toBe('success');
    expect(materialLabel({ ...source, original: true })).toBe('Полный оригинал');
    expect(materialColor({ ...source, original: true })).toBe('info');
    expect(materialLabel({ ...source, attempt: true, original: true })).toBe('Не принят');
    expect(materialColor({ ...source, attempt: true, original: true })).toBe('warning');
    expect(materialLabel({ ...source, kind: 'card' })).toBe('Карточка');
    expect(materialColor({ ...source, kind: 'card' })).toBeNull();
  });

  it('SSR сохраняет пустой редактор, исходную обрезку и ветку без следующего фрагмента', () => {
    const props = { draft, onChange: noop, onRequestRemove: noop, disabled: false, disabledReason: '' };
    expect(textContent(renderToStaticMarkup(createElement(MontageClipEditor, { ...props, clip: undefined })))).toBe(
      'Выберите фрагмент на видеодорожке для точной обрезки.'
    );
    const html = renderToStaticMarkup(createElement(MontageClipEditor, { ...props, clip }));
    const text = textContent(html);
    expect(text).toContain('Выбранная сцена · M1');
    expect(text).toContain('В исходнике: 00:03:00 — 00:04:00 · 30 кадров');
    expect(text).toContain('Ожидаем метаданные длины исходника. Расширение конца станет доступно после загрузки видео.');
    expect(text).not.toContain('Общий стык');
    expect(html).toContain('assets/&lt;роль&gt;&amp;&quot;.mp4');
    expect(html).not.toContain('<роль>');
    const next = { ...clip, id: 'M2', scene: 'M2' };
    const withNext = textContent(renderToStaticMarkup(createElement(MontageClipEditor, { ...props, draft: { ...draft, clips: [clip, next] }, clip })));
    expect(withNext).toContain('Общий стык M1 → M2: кадры переходят от одного плана другому, длина монтажа сохраняется.');
  });

  it('SSR применения вычисляет новые границы последовательным курсором и не читает отсутствующий canonical', () => {
    const next = { ...clip, id: 'M2', scene: 'M2', source_end_frame_exclusive: 150 };
    const view = { scenes: [{ id: 'M1', startFrame: 90, endFrame: 120 }] } as MontageView;
    const text = textContent(
      renderToStaticMarkup(
        createElement(MontageApplyDialog, { open: true, draft: { ...draft, clips: [clip, next] }, view, busy: false, onClose: noop, onApply: noop })
      )
    );
    expect(text).toContain('M1: 00:00:00 — 00:01:00 (было 00:03:00 — 00:04:00)');
    expect(text).toContain('M2: 00:01:00 — 00:03:00');
    expect(text).not.toContain('undefined');
  });

  it('обвязка диагностики сохраняет целую ссылку на журнал и безопасный вывод', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(LinkedText, { text: montageTexts.exportFailed('Откройте страницу «Журнал заданий». <script>&') }))
    );
    expect(textContent(html)).toBe('Экспорт MP4 не выполнен. Откройте страницу «Журнал заданий». <script>&');
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('&lt;script&gt;&amp;');
    expect(html).not.toContain('<script>');
  });
});
