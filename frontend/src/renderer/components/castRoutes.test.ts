/** Переход к сущности на «Кастинге» кодирует её код в параметре. */
import { describe, expect, it } from 'vitest';
import { castEntityRoute, ENTITY_PARAM } from './castRoutes';

describe('castEntityRoute', () => {
  it('ведёт на «Кастинг» с кодом сущности в параметре', () => {
    const route = castEntityRoute('hero 1&x');
    expect(route.startsWith('/project/cast?')).toBe(true);
    expect(new URLSearchParams(route.split('?')[1]).get(ENTITY_PARAM)).toBe('hero 1&x');
  });
});
