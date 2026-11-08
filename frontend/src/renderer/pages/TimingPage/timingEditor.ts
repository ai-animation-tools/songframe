/** Идентичность редактора принадлежит физической строке текста, а не перенумеровываемому id файла. */
import type { LyricsLine, TimingFile, TimingLine } from '@shared/types';
import { hasMinimumTimingLength } from '@shared/timing-validation';
import { timingEditorTexts } from '@shared/texts/timing-editor';
import { applyTimingBoundaryDrafts, type TimingBoundaryDrafts } from './manualTiming';

export type TimingCandidate = NonNullable<TimingFile['candidates']>[number];
export type TimingEditorFilter = 'all' | 'remaining' | 'verified';

/** Проверка подтверждения общая для кнопки, горячей клавиши и массового действия; пересечения проверяет Save. */
export function canVerifyEditorLine(line: TimingLine): boolean {
  return hasMinimumTimingLength(line.start, line.end);
}

export function sourceLyrics(lyrics: LyricsLine[]): LyricsLine[] {
  return lyrics.filter((line) => !line.header && !!line.text.trim());
}

export function editorLineOrder(lyrics: LyricsLine[], order: number[] = []): number[] {
  const source = sourceLyrics(lyrics).map((line) => line.number);
  const allowed = new Set(source);
  return [...new Set([...order.filter((number) => allowed.has(number)), ...source])];
}

export function stableTimingLines(lines: TimingLine[]): TimingLine[] {
  return lines.map((line) => ({ ...line, id: line.source_line }));
}

/** Пустая строка получает только экранный объект с NaN: выдуманных времён в документе нет. */
export function editorTimingRows(lyrics: LyricsLine[], lines: TimingLine[], candidates: TimingCandidate[], order: number[]): TimingLine[] {
  const accepted = new Map(lines.map((line) => [line.source_line, line]));
  const proposed = new Map(candidates.map((candidate) => [candidate.source_line, candidate]));
  return editorLineOrder(lyrics, order).map((number) => {
    const line = accepted.get(number);
    const candidate = proposed.get(number);
    return line
      ? { ...line, id: number }
      : { id: number, source_line: number, start: candidate?.start ?? Number.NaN, end: candidate?.end ?? Number.NaN, verified: false, note: candidate?.note };
  });
}

/** Только полностью пустые интервалы пропускаются; частичный ввод получает адресную ошибку до вызова Go. */
export function collectEditorLines(lines: TimingLine[], drafts: TimingBoundaryDrafts): { lines: TimingLine[]; problems: string[] } {
  const problems: string[] = [];
  const result = applyTimingBoundaryDrafts(lines, drafts).filter((line) => {
    const draft = drafts[line.id];
    const start = draft?.start ?? (Number.isFinite(line.start) ? String(line.start) : '');
    const end = draft?.end ?? (Number.isFinite(line.end) ? String(line.end) : '');
    if (!start.trim() && !end.trim()) {
      // Заметка уже является работой пользователя: без интервала не теряем её успешным пустым Save.
      if (line.note?.trim()) {
        problems.push(timingEditorTexts.partial({ number: line.source_line }));
        return true;
      }
      return false;
    }
    if (!start.trim() || !end.trim()) problems.push(timingEditorTexts.partial({ number: line.source_line }));
    else if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) problems.push(timingEditorTexts.invalid({ number: line.source_line }));
    return true;
  });
  return { lines: result, problems };
}

export function moveEditorLine(order: number[], from: number, to: number): number[] {
  const next = order.filter((number) => number !== from);
  const index = order.indexOf(to);
  if (from === to || !order.includes(from) || index < 0) return order;
  next.splice(index, 0, from);
  return next;
}

export function visibleEditorRows(lines: TimingLine[], filter: TimingEditorFilter): TimingLine[] {
  return lines.filter((line) => filter === 'all' || (filter === 'verified' ? !!line.verified : !line.verified));
}
