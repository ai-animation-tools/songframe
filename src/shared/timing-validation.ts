/** Единая проверка сохранения: редактор допускает промежуточные интервалы, файл — только корректную разметку. */
import type { LyricsLine, TimingFile } from './types';
import { timingTexts } from './texts/timing';

export const MIN_TIMING_LENGTH = 0.3;

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
    else if (line.end - line.start < MIN_TIMING_LENGTH) problems.push(timingTexts.main.lineTooShort({ id: line.id, minLength: MIN_TIMING_LENGTH }));
    else if (line.start < 0) problems.push(timingTexts.main.negativeStart({ id: line.id }));
    else if (duration && line.end > duration + 0.5) problems.push(timingTexts.main.endOutsideTrack({ id: line.id }));
  }
  const ordered = [...timing.lines].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end - 0.001) problems.push(timingTexts.main.overlappingLines({ first: ordered[i - 1].id, second: ordered[i].id }));
  }
  return problems;
}
