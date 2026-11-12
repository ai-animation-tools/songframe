/**
 * История правок страницы таймингов: локальная отмена и повтор без записи файла.
 *
 * Перед каждой правкой страница передаёт снимок своего черновика. Правки одного жеста
 * (перетаскивание, удержание клавиши, ввод в одно поле) приходят с одинаковым ключом и
 * образуют один шаг. Несколько правок одного события (обе строки пары) видят ещё не
 * перерисованный черновик: совпадающий снимок второй раз не записывается.
 */

/** Сколько шагов хранится; более ранние отбрасываются. */
export const TIMING_HISTORY_LIMIT = 200;

export interface TimingHistory<T> {
  undo: T[];
  redo: T[];
  /** Ключ жеста последнего шага; null — отдельная правка без продолжения. */
  lastKey: string | null;
}

export function emptyTimingHistory<T>(): TimingHistory<T> {
  return { undo: [], redo: [], lastKey: null };
}

/** Запоминает состояние до правки. Продолжение того же жеста и повтор снимка шаг не добавляют. */
export function recordTimingStep<T>(history: TimingHistory<T>, before: T, key: string | null, same: (a: T, b: T) => boolean): TimingHistory<T> {
  if (key !== null && key === history.lastKey) return history;
  const top = history.undo[history.undo.length - 1];
  if (top !== undefined && same(top, before)) return history.lastKey === key ? history : { ...history, lastKey: key };
  return { undo: [...history.undo, before].slice(-TIMING_HISTORY_LIMIT), redo: [], lastKey: key };
}

/** Возвращает предыдущее состояние; текущее уходит в повтор. */
export function undoTimingStep<T>(history: TimingHistory<T>, current: T): { history: TimingHistory<T>; state: T } | null {
  if (!history.undo.length) return null;
  const state = history.undo[history.undo.length - 1];
  return { state, history: { undo: history.undo.slice(0, -1), redo: [...history.redo, current], lastKey: null } };
}

/** Возвращает отменённое состояние; текущее снова становится шагом отмены. */
export function redoTimingStep<T>(history: TimingHistory<T>, current: T): { history: TimingHistory<T>; state: T } | null {
  if (!history.redo.length) return null;
  const state = history.redo[history.redo.length - 1];
  return { state, history: { undo: [...history.undo, current].slice(-TIMING_HISTORY_LIMIT), redo: history.redo.slice(0, -1), lastKey: null } };
}
