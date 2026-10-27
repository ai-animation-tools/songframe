/** Обновляет только служебную фразу проверки на слух, сохраняя оценку распознавания и ручные заметки. */
import type { TimingLine } from './types';

export function withTimingVerification(line: TimingLine, verified = !!line.verified): TimingLine {
  // Границы отдельной фразы не дают заменить упоминание проверки внутри произвольного комментария.
  const note = line.note?.replace(
    /(^|[.;])(\s*)(?:сверка на слух не выполнена|сверка на слух выполнена)(?=\s*(?:[.;]|$))/giu,
    (_match, boundary: string, space: string) => `${boundary}${space}${verified ? 'сверка на слух выполнена' : 'сверка на слух не выполнена'}`
  );
  return { ...line, verified, note };
}
