/** Сохранённая музыкальная карта общая для шкалы и записи; автоматический расчёт нужен только при её отсутствии. */
import type { LyricsLine, TimingLine, TimingSection } from './types';

const GAP_THRESHOLD = 2;

/** Правки вокальных строк не должны стирать самостоятельные переходы, затухания и ручные заметки секций. */
export function resolveTimingSections(
  sections: TimingSection[] | undefined,
  lyrics: LyricsLine[],
  lines: TimingLine[],
  duration: number | null
): TimingSection[] {
  return sections?.length ? sections : buildSections(lyrics, lines, duration);
}

/** Части по заголовкам текста плюс вступление, проигрыши и финал без вокала; тот же алгоритм, что в align_lyrics. */
export function buildSections(lyrics: LyricsLine[], lines: TimingLine[], duration: number | null): TimingSection[] {
  const byNumber = new Map(lines.map((l) => [l.source_line, l]));
  const parts: { name: string; members: TimingLine[] }[] = [];
  let current: { name: string; members: TimingLine[] } | null = null;
  for (const lyric of lyrics) {
    if (lyric.header) {
      current = { name: lyric.text.slice(1, -1).trim(), members: [] };
      parts.push(current);
    } else if (lyric.text) {
      if (!current) {
        // eslint-disable-next-line no-restricted-syntax -- Имя секции сохраняется в timing.json, это значение данных музыкальной карты.
        current = { name: 'Без названия', members: [] };
        parts.push(current);
      }
      const line = byNumber.get(lyric.number);
      if (line) current.members.push(line);
    }
  }
  const named = parts
    .filter((p) => p.members.length)
    .map((p) => {
      const sorted = [...p.members].sort((a, b) => a.start - b.start);
      return {
        name: p.name,
        start: sorted[0].start,
        end: Math.max(...sorted.map((l) => l.end)),
        // eslint-disable-next-line no-restricted-syntax -- Диапазон строк записывается в note музыкальной карты timing.json.
        note: `строки ${sorted[0].id}–${sorted[sorted.length - 1].id}`
      };
    });
  const sections: TimingSection[] = [];
  let cursor = 0;
  named.forEach((part, index) => {
    if (part.start - cursor >= GAP_THRESHOLD) {
      sections.push({
        // eslint-disable-next-line no-restricted-syntax -- Автоматические имена секций принадлежат сохраняемой музыкальной карте timing.json.
        name: index === 0 ? 'Вступление' : `Проигрыш после «${named[index - 1].name}»`,
        start: round(cursor),
        end: round(part.start),
        // eslint-disable-next-line no-restricted-syntax -- Служебная заметка сохраняется в note секции timing.json.
        note: 'без вокала'
      });
    }
    sections.push({ name: part.name, start: round(part.start), end: round(part.end), note: part.note });
    cursor = part.end;
  });
  if (duration && duration - cursor >= GAP_THRESHOLD)
    // eslint-disable-next-line no-restricted-syntax -- Имя и заметка финала являются значениями сохраняемой музыкальной карты timing.json.
    sections.push({ name: 'Финал без вокала', start: round(cursor), end: round(duration), note: 'до конца трека' });
  return sections;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
