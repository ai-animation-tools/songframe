/** Идентичность редактора принадлежит физической строке текста, а не перенумеровываемому id файла. */
import type { LyricsLine, TimingFile, TimingLine, TimingSection } from '@shared/types';
import { lyricParts } from '@shared/timing-sections';
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

/** Заголовок секции в списке строк: границы есть у секции музыкальной карты; gap — секция без строк текста. */
export interface EditorSectionHeader {
  key: string;
  name: string;
  start?: number;
  end?: number;
  note?: string;
  gap: boolean;
}

/** Заголовки над строками списка (по id строки) и секции после последней строки. */
export interface EditorSectionLayout {
  before: Map<number, EditorSectionHeader[]>;
  after: EditorSectionHeader[];
}

/**
 * Раскладывает текущую музыкальную карту по списку строк. Часть текста получает заголовок над первой видимой
 * строкой и границы секции с тем же названием, сильнее всего перекрывающей её строки: так различаются
 * одинаковые припевы. Секции без строк (вступление, проигрыш, финал, ручные) встают по времени перед
 * первой частью, которая начинается не раньше них, а оставшиеся — после списка. Карта пересчитывается
 * вызывающим кодом при каждой правке границ, поэтому заголовки следуют за ней сами.
 */
export function editorSectionLayout(lyrics: LyricsLine[], sections: TimingSection[], rows: TimingLine[], visible: TimingLine[]): EditorSectionLayout {
  const parts = lyricParts(lyrics);
  const ranges = new Map<number, { start: number; end: number }>();
  for (const row of rows) {
    const part = parts.get(row.source_line);
    if (!part || !Number.isFinite(row.start) || !Number.isFinite(row.end)) continue;
    const range = ranges.get(part.index);
    ranges.set(part.index, range ? { start: Math.min(range.start, row.start), end: Math.max(range.end, row.end) } : { start: row.start, end: row.end });
  }
  const free = [...sections].sort((left, right) => left.start - right.start);
  const matched = new Map<number, TimingSection>();
  const names = new Map([...parts.values()].map((part) => [part.index, part.name]));
  for (const [index, range] of [...ranges].sort((left, right) => left[1].start - right[1].start)) {
    let best = -1;
    let overlap = 0;
    free.forEach((section, position) => {
      const shared = Math.min(section.end, range.end) - Math.max(section.start, range.start);
      if (section.name === names.get(index) && shared > overlap) {
        best = position;
        overlap = shared;
      }
    });
    if (best >= 0) matched.set(index, free.splice(best, 1)[0]);
  }
  const header = (section: TimingSection, gap: boolean): EditorSectionHeader => ({
    key: `${section.name}:${section.start}`,
    name: section.name,
    start: section.start,
    end: section.end,
    note: gap ? section.note : undefined,
    gap
  });
  const before = new Map<number, EditorSectionHeader[]>();
  let previous: number | undefined;
  for (const row of visible) {
    const part = parts.get(row.source_line);
    if (!part || part.index === previous) continue;
    previous = part.index;
    const headers: EditorSectionHeader[] = [];
    const range = ranges.get(part.index);
    if (range) while (free.length && free[0].start < range.start + 0.001) headers.push(header(free.shift() as TimingSection, true));
    const section = matched.get(part.index);
    if (section) headers.push(header(section, false));
    else if (part.titled) headers.push({ key: `part:${part.index}`, name: part.name, gap: false });
    if (headers.length) before.set(row.id, headers);
  }
  return { before, after: free.map((section) => header(section, true)) };
}
