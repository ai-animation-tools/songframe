/** Независимые ожидания сохраняют фразы, параметры и пробелы JSX при переносе текстов. */
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { checksTexts } from '@shared/texts/checks';
import type { ShotProduction } from '@shared/types';
import { ReviewPanel } from './components/ReviewPanel';

function shot(id: string, asset: ShotProduction['asset'] = null): ShotProduction {
  return {
    id,
    title: 'План «А» <script>&',
    original: id,
    start: 0,
    end: 2,
    lipsync: false,
    state: 'planned',
    stageLabel: 'новый',
    regenerateProblem: null,
    derivedFrom: null,
    attention: null,
    asset,
    packages: []
  };
}

function render(overrides: Partial<ComponentProps<typeof ReviewPanel>> = {}): string {
  return renderToStaticMarkup(
    createElement(ReviewPanel, {
      shots: [],
      selected: [],
      planOnly: false,
      disabled: false,
      disabledReason: null,
      reviews: [],
      openReview: null,
      deletingReview: null,
      setPlanOnly: vi.fn(),
      toggleShot: vi.fn(),
      clearSelection: vi.fn(),
      buildReview: vi.fn(),
      setOpenReview: vi.fn(),
      openDirectory: vi.fn(),
      removeReview: vi.fn(),
      ...overrides
    })
  ).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

describe('целые фразы проверок', () => {
  it('сохраняет заголовки обычной пробы и проверки без видео', () => {
    expect(checksTexts.reviewJobTitle({ shots: ['M05', 'M05.1'], planOnly: false })).toBe('Проба M05 M05.1');
    expect(checksTexts.reviewJobTitle({ shots: ['M05', 'M05.1'], planOnly: true })).toBe('Проба M05 M05.1 (проверка без видео)');
    expect(checksTexts.checkJobTitle('Данные сцен')).toBe('Проверка: Данные сцен');
    expect(checksTexts.invalidReviewShots(['x', '../M05'])).toBe('Коды планов вида M05 или M05.1: x, ../M05');
  });

  it('сохраняет списки заданий и пользовательские кавычки, пути и спецсимволы', () => {
    expect(checksTexts.jobsDone(['Проба M05', 'Проверка: «данные»'])).toBe('Готово: Проба M05, Проверка: «данные»');
    expect(checksTexts.jobsFailed(['Проба M05', 'Проверка: «данные»'])).toBe(
      'Завершено с ошибками: Проба M05, Проверка: «данные». Подробности — в журнале заданий.'
    );
    expect(checksTexts.projectReadFailed({ path: 'C:\\Клип «А»\\plan\\project.json', error: '<ошибка> & причина' })).toBe(
      'Не удалось прочитать C:\\Клип «А»\\plan\\project.json: <ошибка> & причина'
    );
    expect(checksTexts.projectObjectRequired('plan/project.json')).toBe('plan/project.json должен быть объектом.');
    expect(checksTexts.deleteReviewDescription('проба «А» & B.mp4')).toBe(
      'Будут удалены MP4 пробы «проба «А» & B.mp4» и её рецепт. Исходные медиа и другие файлы в папке сохранятся.'
    );
  });

  it('возвращает целые сообщения полей настроек с прежним префиксом', () => {
    expect(checksTexts.generationObjectRequired('video')).toBe('generation.video: ожидается объект настроек.');
    expect(checksTexts.generationFieldRequired({ kind: 'image', field: 'provider' })).toBe('generation.image: не заполнено поле provider.');
    expect(checksTexts.generationStringRequired({ kind: 'image', field: 'model' })).toBe('generation.image: model должен быть непустой строкой.');
    expect(checksTexts.generationAspectRatioInvalid('image')).toBe('generation.image: пропорции записываются как 16:9 или auto.');
    expect(checksTexts.generationWatermarkInvalid('video')).toBe('generation.video: watermark должен быть логическим значением.');
    expect(checksTexts.generationDurationRuleInvalid({ kind: 'video', rules: ['exact_window', 'ceil_seconds'] })).toBe(
      'generation.video: правило длительности должно быть одним из: exact_window, ceil_seconds.'
    );
    expect(checksTexts.generationProviderSelectedInvalid('image')).toBe('generation.image: provider_selected должен быть логическим значением.');
    expect(checksTexts.generationOptionsInvalid('video')).toBe('generation.video: options должен быть объектом.');
    expect(checksTexts.generationOutputsInvalid('image')).toBe('generation.image: outputs должен быть положительным целым числом.');
  });

  it.each([
    [0, '0.0 с'],
    [1, '1.0 с'],
    [2, '2.0 с'],
    [5, '5.0 с'],
    [11, '11.0 с'],
    [21, '21.0 с'],
    [-1, '-1.0 с'],
    [1.25, '1.3 с']
  ] as const)('сохраняет формат длительности %s', (seconds, expected) => {
    expect(checksTexts.reviewDuration(seconds)).toBe(expected);
  });
});

describe('текст панели пробы', () => {
  it('сохраняет целый абзац с одним пробелом на месте переноса JSX', () => {
    const html = render();
    expect(html).toContain(
      'Соберите временный ролик, чтобы оценить переходы между планами. Готовые планы будут показаны принятыми клипами, остальные — карточками, под непрерывный участок музыки. Проба сохраняется в plan/batches. Она не заменяет аниматик, её сборка не означает приёмку сцен.'
    );
    expect(html).toContain(
      'Для диапазона выберите первую сцену, затем последнюю с зажатым Shift. Диапазон добавится к выбранным сценам. С клавиатуры: Shift + Enter.'
    );
    expect(html).toContain('Планы появятся после сборки реестра сцен.');
    expect(html).toContain('title="Выберите сцены для пробы."');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Собрать<\/button>/);
  });

  it('сохраняет разные подписи отсутствующего видео и безопасно отображает пользовательский заголовок', () => {
    const html = render({
      shots: [
        shot('M01'),
        shot('M02', { dir: 'assets/M02', video: null, original: null }),
        shot('M03', { dir: 'assets/M03', video: 'video.mp4', original: null })
      ],
      selected: ['M01'],
      planOnly: true
    });
    expect(html).toContain('title="План «А» &lt;script&gt;&amp; · новый · пойдёт карточкой"');
    expect(html).toContain('title="План «А» &lt;script&gt;&amp; · новый"');
    expect(html).toMatch(/>M01<\/span>/);
    expect(html).toContain('M02 · видео отсутствует');
    expect(html).not.toContain('M01 · видео отсутствует');
    expect(html).not.toContain('M03 · видео отсутствует');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Снять выбор');
    expect(html).toMatch(/<button(?![^>]* disabled)[^>]*>[\s\S]*?Проверить<\/button>/);
  });

  it('сохраняет причины недоступности для несмежного выбора и удаления', () => {
    const props = { shots: [shot('M01'), shot('M02'), shot('M03')], selected: ['M01', 'M03'] };
    expect(render(props)).toContain('title="Выберите сцены подряд: проба собирается под непрерывный участок песни. Диапазон удобно выбрать щелчком с Shift."');
    expect(render({ ...props, deletingReview: 'review.mp4' })).toContain('title="Дождитесь окончания удаления пробы."');
  });
});
