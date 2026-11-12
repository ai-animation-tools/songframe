import { describe, expect, it } from 'vitest';
import { TIMING_HISTORY_LIMIT, emptyTimingHistory, recordTimingStep, redoTimingStep, undoTimingStep } from './timingHistory';

const same = (a: { v: number }, b: { v: number }): boolean => a === b;

describe('история правок таймингов', () => {
  it('один жест — один шаг, отдельные правки — отдельные шаги', () => {
    const s0 = { v: 0 },
      s1 = { v: 1 },
      s2 = { v: 2 };
    let history = recordTimingStep(emptyTimingHistory<{ v: number }>(), s0, 'drag:1', same);
    history = recordTimingStep(history, s1, 'drag:1', same);
    expect(history.undo).toEqual([s0]);
    history = recordTimingStep(history, s1, null, same);
    history = recordTimingStep(history, s2, null, same);
    expect(history.undo).toEqual([s0, s1, s2]);
  });

  it('правки одного события с тем же снимком не дублируют шаг', () => {
    const s0 = { v: 0 };
    let history = recordTimingStep(emptyTimingHistory<{ v: number }>(), s0, null, same);
    history = recordTimingStep(history, s0, null, same);
    expect(history.undo).toEqual([s0]);
  });

  it('отмена и повтор меняют состояния местами, новая правка очищает повтор', () => {
    const s0 = { v: 0 },
      s1 = { v: 1 },
      s2 = { v: 2 };
    let history = recordTimingStep(emptyTimingHistory<{ v: number }>(), s0, null, same);
    const undone = undoTimingStep(history, s1)!;
    expect(undone.state).toBe(s0);
    expect(undone.history.redo).toEqual([s1]);
    const redone = redoTimingStep(undone.history, s0)!;
    expect(redone.state).toBe(s1);
    expect(redone.history.undo).toEqual([s0]);
    history = recordTimingStep(undone.history, s0, 'drag:2', same);
    expect(history.redo).toEqual([]);
    expect(undoTimingStep(emptyTimingHistory(), s2)).toBeNull();
    expect(redoTimingStep(emptyTimingHistory(), s2)).toBeNull();
  });

  it('после отмены тот же жест начинает новый шаг', () => {
    const s0 = { v: 0 },
      s1 = { v: 1 };
    const history = recordTimingStep(emptyTimingHistory<{ v: number }>(), s0, 'input:1:start', same);
    const undone = undoTimingStep(history, s1)!;
    expect(recordTimingStep(undone.history, s0, 'input:1:start', same).undo).toEqual([s0]);
  });

  it('хранит не больше предела шагов', () => {
    let history = emptyTimingHistory<{ v: number }>();
    for (let v = 0; v < TIMING_HISTORY_LIMIT + 5; v++) history = recordTimingStep(history, { v }, null, same);
    expect(history.undo).toHaveLength(TIMING_HISTORY_LIMIT);
    expect(history.undo[0].v).toBe(5);
  });
});
