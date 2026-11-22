import { describe, expect, it } from 'vitest';
import { directionAt } from './WindCompass';

describe('компас ветра', () => {
  it('переводит точку в градусы против часовой от востока', () => {
    // Центр компаса 66×66: справа — восток, сверху — север.
    expect(directionAt(120, 66)).toBe(0);
    expect(directionAt(66, 10)).toBe(90);
    expect(directionAt(10, 66)).toBe(180);
    expect(directionAt(66, 120)).toBe(270);
  });
});
