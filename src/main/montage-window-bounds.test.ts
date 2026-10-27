import { describe, expect, it } from 'vitest';
import { usableMontageBounds } from './montage-window-bounds';

describe('Положение отдельного окна монтажа', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  it('восстанавливает окно на доступном мониторе', () => {
    const bounds = { x: 700, y: 200, width: 800, height: 500 };
    expect(usableMontageBounds(bounds, displays)).toEqual(bounds);
  });
  it('не восстанавливает окно за пределами экранов или повреждённые размеры', () => {
    expect(usableMontageBounds({ x: 3000, y: 100, width: 800, height: 500 }, displays)).toBeUndefined();
    expect(usableMontageBounds({ x: 100, y: -300, width: 800, height: 500 }, displays)).toBeUndefined();
    expect(usableMontageBounds({ x: 0, y: 0, width: 0, height: 500 }, displays)).toBeUndefined();
  });
});
