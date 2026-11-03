import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnimaticShot, AnimaticView } from '@shared/types';
import { animaticTexts } from '@shared/texts/animatic';
import { AnimaticPlayer } from './components/AnimaticPlayer';
import { ShotCard } from './components/ShotCard';

/** Независимые ожидания проверяют числовые формы и сохранение JSX-слота даты. */
describe('тексты просмотра аниматика', () => {
  it.each([
    [0, 'планов', 'кадров'],
    [1, 'план', 'кадр'],
    [2, 'плана', 'кадра'],
    [5, 'планов', 'кадров'],
    [11, 'планов', 'кадров'],
    [21, 'план', 'кадр'],
    [-2, 'плана', 'кадра'],
    [1.5, 'плана', 'кадра']
  ] as const)('согласует числовые подписи для %s', (count, shotsWord, framesWord) => {
    expect(animaticTexts.shot.timing({ start: '0:00', end: '0:02', frames: count })).toBe(`0:00–0:02 · ${count} ${framesWord}`);
    expect(animaticTexts.playbackSummary({ time: '0:01', duration: '0:02', shots: count, video: count, keyframes: count, cards: count })).toBe(
      `0:01 / 0:02 · ${count} ${shotsWord}: анимация: ${count}, опоры: ${count}, карточки: ${count} · собрано {builtAt}`
    );
  });

  it('сохраняет заголовки уведомлений и параметры с кавычками и путями', () => {
    expect(animaticTexts.jobFailed({ title: '«C:\\клип\\план.mp4» & проверка' })).toBe('«C:\\клип\\план.mp4» & проверка: ошибка, см. журнал');
    expect(animaticTexts.jobReady({ title: '«Сборка» <1>' })).toBe('«Сборка» <1>: готово');
    expect(animaticTexts.shot.lastCard({ shot: '<M01> {shot}' })).toBe('<M01> {shot} последняя опора');
  });

  it('сохраняет компонент даты и точный пробел перед ним', () => {
    const built = { counts: { video: 1, keyframes: 2, cards: 5 }, builtAt: '2026-10-29T12:00:00Z' } as NonNullable<AnimaticView['built']>;
    const markup = renderToStaticMarkup(
      createElement(AnimaticPlayer, {
        built,
        videoRef: { current: null },
        videoUrl: undefined,
        seekRequested: () => {},
        setTime: () => {},
        shots: [],
        current: null,
        seek: () => {},
        duration: 2,
        time: 1,
        onOpenFolder: () => {}
      })
    );
    expect(markup).toContain('0:01.00 / 0:02.00 · 0 планов: анимация: 1, опоры: 2, карточки: 5 · собрано <time dateTime="2026-10-29T12:00:00.000Z">');
    expect(markup).not.toContain('{builtAt}');
  });

  it('выводит постановку с прежним выделением и безопасными пользовательскими данными', () => {
    const markup = renderToStaticMarkup(
      createElement(ShotCard, {
        shot: { id: 'M01', media: 'video', start: 0, end: 2, frames: 1, camera: '', action: '<движение> {label}' } as AnimaticShot
      })
    );
    expect(markup).toContain('0:00.00–0:02.00 · 1 кадр');
    expect(markup).toContain('<b>Камера.</b> не задана');
    expect(markup).toContain('<b>Действие.</b> &lt;движение&gt; {label}');
    expect(markup).not.toContain('<движение>');
  });
});
