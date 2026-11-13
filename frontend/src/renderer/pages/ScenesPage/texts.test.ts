import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardShot } from '@shared/types';
import { scenesTexts } from '@shared/texts/scenes';
import { ShotStaging } from './components/ShotStaging';
import { ShotStateBlock } from './components/ShotStateBlock';

/** Ожидания независимы от словаря: проверяют грамматику, пробелы и безопасную вставку данных сцены. */
describe('тексты просмотра сцен', () => {
  it('сохраняет целые фразы с путями, кавычками и пустыми JSX-параметрами', () => {
    expect(scenesTexts.details.timing({ start: '0:00', end: '0:02', frames: 21, sequence: undefined })).toBe('0:00–0:02 · 21 кадр · ');
    expect(scenesTexts.details.timing({ start: '0:00', end: '0:02', frames: 21, sequence: null })).toBe('0:00–0:02 · 21 кадр · ');
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
