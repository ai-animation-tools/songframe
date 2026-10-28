/** Подсказки следующего шага ведут к кнопкам приложения, а не к ручному запуску агента. */
import { describe, expect, it } from 'vitest';
import type { ProjectState, ProjectStatus } from '@shared/types';
import { nextStep } from './nextStep';

const status = (state: ProjectState, checks: Partial<ProjectStatus['checks']> = {}): ProjectStatus => ({
  path: '/project',
  state,
  name: 'Клип',
  animaticVideo: null,
  checks: {
    marker: true,
    sources: true,
    timing: false,
    cast: false,
    treatment: false,
    scenes: false,
    shotsTotal: 0,
    shotsDone: 0,
    animaticBuilt: false,
    animaticFresh: false,
    animaticApproved: false,
    ...checks
  },
  problems: []
});

describe('Подсказка следующего шага', () => {
  it('для разметки называет только кнопку автоматической разметки', () => {
    const step = nextStep(status('sourced'));
    expect(step.text).toContain('«Разметить автоматически»');
    expect(step.text).not.toMatch(/скилл|ai-clip|внешн/i);
    expect(step.action?.to).toBe('/project/timing');
  });

  it('не предлагает вызывать скиллы агента вручную', () => {
    const states = [
      status('timed'),
      status('timed', { cast: true }),
      status('timed', { cast: true, treatment: true }),
      status('scripted', { cast: true, treatment: true, scenes: true })
    ];
    for (const value of states) expect(nextStep(value).text).not.toMatch(/\$ai-clip|\/ai-clip|скилл|вручную/i);
  });
});
