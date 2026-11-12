/** Автоматическая музыкальная карта следует границам строк и кандидатов, ручная сохраняет решения пользователя. */
import type { LyricsLine, TimingCandidate, TimingLine, TimingSection } from './types';

const GAP_THRESHOLD = 2;
type SectionMember = Pick<TimingLine, 'id' | 'start' | 'end'>;
type SectionPart = { name: string; members: SectionMember[]; hasSource: boolean };

/** Полностью ручная карта самостоятельна; у смешанной обновляются только автоматические секции. */
export function resolveTimingSections(
  sections: TimingSection[] | undefined,
  lyrics: LyricsLine[],
  lines: TimingLine[],
  duration: number | null,
  candidates: TimingCandidate[] = []
): TimingSection[] {
  const saved = sections ?? [];
  const partNames = new Set(groupParts(lyrics, new Map()).map((part) => part.name));
  const manual = saved.filter((section) => !isAutoSection(section, partNames));
  if (saved.length && manual.length === saved.length) return saved;
  const manualNames = new Set(manual.map((section) => section.name));
  const generated = buildSections(lyrics, lines, duration, candidates).filter((section) => !manualNames.has(section.name));
  return [...manual, ...generated].sort((left, right) => left.start - right.start);
}

/** Старую автоматику узнаём только по полной системной подписи: незнакомые заметки сохраняются как ручные. */
function isAutoSection(section: TimingSection, partNames: Set<string>): boolean {
  if (section.origin !== undefined) return section.origin === 'auto';
  const { name, note = '' } = section;
  return (
    (partNames.has(name) && note.match(/^строки [1-9]\d*–[1-9]\d*$/)?.[0] === note) ||
    // eslint-disable-next-line no-restricted-syntax -- Имена и заметки старой автоматики являются данными контракта.
    ((name === 'Вступление' || name.match(/^Проигрыш после «.+»$/)?.[0] === name) && note === 'без вокала') ||
    // eslint-disable-next-line no-restricted-syntax -- Полная системная подпись финала, а не предположение по одному названию.
    (name === 'Финал без вокала' && note === 'до конца трека')
  );
}

/** Кандидаты расширяют вокальные части, но не становятся принятыми строками; алгоритм общий с align_lyrics. */
export function buildSections(lyrics: LyricsLine[], lines: TimingLine[], duration: number | null, candidates: TimingCandidate[] = []): TimingSection[] {
  const byNumber = new Map<number, SectionMember>(lines.map((line) => [line.source_line, line]));
  const sourceLines = lyrics.filter((lyric) => !lyric.header && lyric.text);
  sourceLines.forEach((lyric, index) => {
    const candidate = candidates.find((item) => item.source_line === lyric.number);
    if (candidate && !byNumber.has(lyric.number)) byNumber.set(lyric.number, { ...candidate, id: index + 1 });
  });
  const uncertain = candidates.length > 0 || sourceLines.some((lyric) => !lines.some((line) => line.source_line === lyric.number));
  const named: TimingSection[] = groupParts(lyrics, byNumber)
    .filter((part) => part.members.length)
    .map((part) => {
      const sorted = [...part.members].sort((left, right) => left.start - right.start);
      return {
        name: part.name,
        start: sorted[0].start,
        end: Math.max(...sorted.map((line) => line.end)),
        // eslint-disable-next-line no-restricted-syntax -- Диапазон строк записывается в note музыкальной карты timing.json.
        note: `строки ${sorted[0].id}–${sorted[sorted.length - 1].id}`,
        origin: 'auto'
      };
    });
  const sections: TimingSection[] = [];
  let cursor = 0;
  named.forEach((part, index) => {
    if (part.start - cursor >= GAP_THRESHOLD) {
      // eslint-disable-next-line no-restricted-syntax -- Автоматические имена секций принадлежат сохраняемой музыкальной карте.
      const name = index === 0 ? 'Вступление' : `Проигрыш после «${named[index - 1].name}»`;
      sections.push({
        // eslint-disable-next-line no-restricted-syntax -- При неполной карте неизвестный промежуток не объявляется инструменталом.
        name: uncertain ? 'Не размечено' : name,
        start: round(cursor),
        end: round(part.start),
        // eslint-disable-next-line no-restricted-syntax -- Служебная заметка сохраняется в note секции timing.json.
        note: uncertain ? 'границы вокала не подтверждены' : 'без вокала',
        origin: 'auto'
      });
    }
    sections.push({ ...part, start: round(part.start), end: round(part.end) });
    cursor = Math.max(cursor, part.end);
  });
  if (duration && duration - cursor >= GAP_THRESHOLD)
    sections.push({
      // eslint-disable-next-line no-restricted-syntax -- Имя финала является значением сохраняемой музыкальной карты timing.json.
      name: uncertain ? 'Не размечено' : 'Финал без вокала',
      start: round(cursor),
      end: round(duration),
      // eslint-disable-next-line no-restricted-syntax -- Заметка различает неизвестную область и инструментальный хвост полной карты.
      note: uncertain ? 'границы вокала не подтверждены' : 'до конца трека',
      origin: 'auto'
    });
  return sections;
}

/** Части с текстом сохраняются и без найденных границ: их имена нужны для распознавания старой автоматики. */
function groupParts(lyrics: LyricsLine[], byNumber: Map<number, SectionMember>): SectionPart[] {
  const parts: SectionPart[] = [];
  for (const [number, part] of lyricParts(lyrics)) {
    const current = (parts[part.index] ??= { name: part.name, members: [], hasSource: true });
    const line = byNumber.get(number);
    if (line) current.members.push(line);
  }
  return parts.filter(Boolean);
}

/** Часть текста строки песни: порядковый номер части, её название и признак заголовка `[Название]` в тексте. */
export interface LyricPart {
  index: number;
  name: string;
  titled: boolean;
}

/**
 * Часть текста для каждой исполняемой строки по физическому номеру. Строки до первого заголовка образуют часть
 * «Без названия»; заголовок без строк части не создаёт. Общая основа автоматических секций и заголовков редактора.
 */
export function lyricParts(lyrics: LyricsLine[]): Map<number, LyricPart> {
  const result = new Map<number, LyricPart>();
  let index = -1;
  let current: LyricPart | null = null;
  for (const lyric of lyrics) {
    if (lyric.header) {
      current = { index: ++index, name: lyric.text.slice(1, -1).trim(), titled: true };
    } else if (lyric.text) {
      // eslint-disable-next-line no-restricted-syntax -- Имя секции сохраняется в timing.json, это значение данных музыкальной карты.
      current ??= { index: ++index, name: 'Без названия', titled: false };
      result.set(lyric.number, current);
    }
  }
  return result;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
