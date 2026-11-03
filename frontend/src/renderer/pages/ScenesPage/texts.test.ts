import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardShot } from '@shared/types';
import { scenesTexts } from '@shared/texts/scenes';
import { ShotStaging } from './components/ShotStaging';
import { ShotStateBlock } from './components/ShotStateBlock';

/** Ожидания независимы от словаря: проверяют грамматику, пробелы и безопасную вставку данных сцены. */
describe('тексты просмотра сцен', () => {
  it.each([
    [0, '0 кадров, 1.25 с'],
    [1, '1 кадр, 1.25 с'],
    [2, '2 кадра, 1.25 с'],
    [5, '5 кадров, 1.25 с'],
    [11, '11 кадров, 1.25 с'],
    [21, '21 кадр, 1.25 с'],
    [-2, '-2 кадра, 1.25 с'],
    [1.5, '1.5 кадра, 1.25 с']
  ])('сохраняет согласование %s кадров в рецепте', (frames, expected) => {
    expect(scenesTexts.mediaEdit.duration({ frames, duration: '1.25' })).toBe(expected);
  });

  it('сохраняет целые фразы с путями, кавычками и пустыми JSX-параметрами', () => {
    expect(scenesTexts.comparison.failed({ reason: '«C:\\Сцены\\план <2>.mp4» & файл' })).toBe(
      'Не удалось включить синхронное сравнение: «C:\\Сцены\\план <2>.mp4» & файл'
    );
    expect(scenesTexts.mediaEdit.originalCaption({ media: 'video "draft" & <x>' })).toBe('Оригинал · video "draft" & <x>');
    expect(scenesTexts.mediaEdit.originalCaption({ media: null })).toBe('Оригинал');
    expect(scenesTexts.mediaEdit.originalCaption({ media: undefined })).toBe('Оригинал');
    expect(scenesTexts.details.timing({ start: '0:00', end: '0:02', frames: 21, sequence: undefined })).toBe('0:00–0:02 · 21 кадр · ');
    expect(scenesTexts.details.timing({ start: '0:00', end: '0:02', frames: 21, sequence: null })).toBe('0:00–0:02 · 21 кадр · ');
    expect(scenesTexts.inputs.keyframeLabel({ label: '«План» {label}', approved: false })).toBe('«План» {label} · кандидат');
    expect(scenesTexts.inputs.keyframeLabel({ label: '«План» {label}', approved: true })).toBe('«План» {label}');
    expect(scenesTexts.inputs.openImage({ label: '«План» {label}' })).toBe('Открыть изображение: «План» {label}');
    expect(scenesTexts.mediaEdit.interval({ start: '1.00', end: '2.50' })).toBe('участок оригинала 1.00–2.50 с');
    expect(scenesTexts.summary.acceptedDuration({ completed: '0:00', duration: '2:30' })).toBe('0:00 из 2:30 принято');
  });

  it('сохраняет жирные подписи и экранирует постановку без повторного разбора слотов', () => {
    const markup = renderToStaticMarkup(
      createElement(ShotStaging, {
        shot: { camera: '<камера> {label}', action: '', continuity: '& {continuity}', references: [] } as unknown as DashboardShot
      })
    );
    expect(markup).toContain('<b>Камера.</b> &lt;камера&gt; {label}');
    expect(markup).toContain('<b>Действие.</b> не задано');
    expect(markup).toContain('<b>Связь.</b> &amp; {continuity}');
    expect(markup).not.toContain('<камера>');
  });

  it('сохраняет фильтрацию служебного префикса состояния и целую фразу проверки', () => {
    const data = { lines: ['Состояние не задано: служебная причина', 'Герой: <куртка>'], checklist: ['левый кадр', 'правый & кадр'] } as NonNullable<
      DashboardShot['before']
    >;
    const markup = renderToStaticMarkup(createElement(ShotStateBlock, { title: 'На первый кадр', data }));
    expect(markup).toContain('<b>Герой</b>: &lt;куртка&gt;');
    expect(markup).not.toContain('служебная причина');
    expect(markup).toContain('Проверить по кадру: левый кадр; правый &amp; кадр');
    expect(renderToStaticMarkup(createElement(ShotStateBlock, { title: 'На первый кадр', data: null }))).toContain('На первый кадр: не вычислено.');
  });
});
