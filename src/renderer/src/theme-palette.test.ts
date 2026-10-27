import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { themePalettes } from './theme-palette';

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
});
