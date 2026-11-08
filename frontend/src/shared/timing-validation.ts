/** Единая проверка сохранения: редактор допускает промежуточные интервалы, файл — только корректную разметку. */
import type { LyricsLine, TimingCandidate, TimingFile } from './types';
import { timingTexts } from './texts/timing';

export const MIN_TIMING_LENGTH = 0.3;

/** Вычитание десятичных секунд может сделать законные 300 мс чуть короче порога.
 * Допуск в наносекунду компенсирует только погрешность чисел, не округляя границы документа. */
export function hasMinimumTimingLength(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= MIN_TIMING_LENGTH - 1e-9;
}

/** Проверяем недоверенный JSON до передачи редактору; предложения не обязаны быть непересекающимися. */
export function isTimingCandidateList(value: unknown): value is TimingCandidate[] {
  return (
    Array.isArray(value) &&
    value.every((candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const item = candidate as Partial<TimingCandidate>;
      return (
        Number.isSafeInteger(item.source_line) &&
        Number(item.source_line) > 0 &&
        typeof item.start === 'number' &&
        Number.isFinite(item.start) &&
        item.start >= 0 &&
        typeof item.end === 'number' &&
        Number.isFinite(item.end) &&
        item.end > item.start &&
        (item.note === undefined || typeof item.note === 'string') &&
        typeof item.reason === 'string' &&
        !!item.reason.trim() &&
        (item.acoustic_score === undefined || (Number.isFinite(item.acoustic_score) && item.acoustic_score >= 0 && item.acoustic_score <= 1))
      );
    })
  );
}

export function validateTiming(timing: TimingFile, lyrics: LyricsLine[], duration: number | null): string[] {
  const problems: string[] = [];
  const byNumber = new Map(lyrics.map((l) => [l.number, l]));
  const ids = new Set<number>();
  const numbers = new Set<number>();
  for (const line of timing.lines) {
    if (ids.has(line.id)) problems.push(timingTexts.main.duplicateId({ id: line.id }));
    ids.add(line.id);
    if (numbers.has(line.source_line)) problems.push(timingTexts.main.duplicateSourceLine({ id: line.id, sourceLine: line.source_line }));
    numbers.add(line.source_line);
    const lyric = byNumber.get(line.source_line);
    if (!lyric || lyric.header || !lyric.text) problems.push(timingTexts.main.missingSourceLine({ id: line.id, sourceLine: line.source_line }));
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) problems.push(timingTexts.main.invalidBoundaries({ id: line.id }));
    else if (!hasMinimumTimingLength(line.start, line.end)) problems.push(timingTexts.main.lineTooShort({ id: line.id, minLength: MIN_TIMING_LENGTH }));
    else if (line.start < 0) problems.push(timingTexts.main.negativeStart({ id: line.id }));
    else if (duration && line.end > duration + 0.5) problems.push(timingTexts.main.endOutsideTrack({ id: line.id }));
  }
  if (timing.candidates !== undefined) {
    if (!isTimingCandidateList(timing.candidates)) problems.push(timingTexts.main.invalidCandidates);
    else {
      const seen = new Set<number>();
      for (const candidate of timing.candidates) {
        const lyric = byNumber.get(candidate.source_line);
        if (seen.has(candidate.source_line) || !lyric || lyric.header || !lyric.text.trim() || (duration && candidate.end > duration + 0.5))
          problems.push(timingTexts.main.invalidCandidates);
        seen.add(candidate.source_line);
      }
    }
  }
  if (
    timing.line_order !== undefined &&
    (!Array.isArray(timing.line_order) ||
      new Set(timing.line_order).size !== timing.line_order.length ||
      timing.line_order.some((number) => {
        const lyric = byNumber.get(number);
        return !Number.isSafeInteger(number) || !lyric || lyric.header || !lyric.text.trim();
      }))
  )
    problems.push(timingTexts.main.invalidLineOrder);
  const ordered = [...timing.lines].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end - 0.001) problems.push(timingTexts.main.overlappingLines({ first: ordered[i - 1].id, second: ordered[i].id }));
  }
  return problems;
}
