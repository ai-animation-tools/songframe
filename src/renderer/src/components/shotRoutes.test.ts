/** Переходы к тому же плану на других страницах передают его код параметром ?shot=. */
import { describe, expect, it } from 'vitest';
import { SHOT_PARAM, shotPageRoute } from './shotRoutes';

describe('shotPageRoute', () => {
  it('открывает план на «Производстве» и «Сценарии»', () => {
    expect(shotPageRoute('production', 'M05')).toBe('/project/production?shot=M05');
    expect(shotPageRoute('scenario', 'M05')).toBe('/project/scenario?shot=M05');
  });

  it('кодирует код плана так, что страница читает его без изменений', () => {
    const route = shotPageRoute('scenario', 'M05.1 &x');
    expect(new URLSearchParams(route.split('?')[1]).get(SHOT_PARAM)).toBe('M05.1 &x');
  });
});
