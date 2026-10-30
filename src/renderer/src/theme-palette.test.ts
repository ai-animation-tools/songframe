import { describe, expect, it } from 'vitest';
import { createTheme, decomposeColor, getContrastRatio } from '@mui/material/styles';
import { themePalettes } from './theme-palette';

/** getContrastRatio игнорирует прозрачность: полупрозрачный текст сначала накладывается на фон, как в браузере. */
function contrast(foreground: string, background: string): number {
  const { values } = decomposeColor(foreground);
  const alpha = values[3] ?? 1;
  const base = decomposeColor(background).values;
  const mixed = [0, 1, 2].map((index) => Math.round(values[index] * alpha + base[index] * (1 - alpha)));
  return getContrastRatio(`rgb(${mixed.join(', ')})`, background);
}

describe('палитры приложения', () => {
  // Проверяем результат createTheme: изменение исходных цветов или их подмена затрагивает все страницы.
  it.each([
    ['light', '#1565c0', '#2e7d32', '#d32f2f', '#f4f6f8', 'rgba(0, 0, 0, 0.87)', 'rgba(0, 0, 0, 0.12)'],
    ['dark', '#7cc4ff', '#66bb6a', '#f44336', '#121417', '#fff', 'rgba(255, 255, 255, 0.12)']
  ] as const)('сохраняет основные цвета и состояния темы %s', (mode, primary, success, error, background, text, divider) => {
    const palette = createTheme({ palette: themePalettes[mode] }).palette;
    expect(palette.mode).toBe(mode);
    expect(palette.primary.main).toBe(primary);
    expect(palette.success.main).toBe(success);
    expect(palette.error.main).toBe(error);
    expect(palette.background.default).toBe(background);
    expect(palette.text.primary).toBe(text);
    expect(palette.divider).toBe(divider);
    expect(palette.action.disabledBackground).toBe(divider);
  });

  // Чипы состояния, шкала планов и контурные элементы показывают текст на основном цвете (dark — при наведении)
  // и основной цвет как текст на бумаге и фоне страницы.
  it.each(['light', 'dark'] as const)('держит контраст статусных цветов темы %s не ниже WCAG AA', (mode) => {
    const palette = createTheme({ palette: themePalettes[mode] }).palette;
    for (const color of [palette.primary, palette.info, palette.warning, palette.success, palette.error]) {
      for (const fill of [color.main, color.dark]) expect(contrast(color.contrastText, fill)).toBeGreaterThanOrEqual(4.5);
      for (const page of [palette.background.paper, palette.background.default]) expect(contrast(color.main, page)).toBeGreaterThanOrEqual(4.5);
    }
    // Подсветка найденного текста в справке. @link src/renderer/src/pages/HelpPage/components/HighlightedText.tsx
    expect(contrast(palette.getContrastText(palette.warning.light), palette.warning.light)).toBeGreaterThanOrEqual(4.5);
  });
});
