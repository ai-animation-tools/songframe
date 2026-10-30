/** Общий формат текста песни для формы, загрузки файла и редактора таймингов. */
import type { LyricsLine, TimingLine } from './types';
import { lyricsTexts } from './texts/lyrics';

const HEADER = /^\[([^[\]]+)\]$/;
const SECTION_TITLE = /^(?:[а-яёa-z]+\s+){0,2}(?:припев|куплет|бридж|интро|вступление|аутро|проигрыш|кода|финал|запев)(?:\s+(?:[а-яёa-z]+|\d+)){0,2}[:.]?$/i;

export const LYRICS_FORMAT_HINT = lyricsTexts.formatHint;

export function analyzeLyrics(text: string): { rows: LyricsLine[]; lines: number; sections: string[]; problems: string[] } {
  const sections: string[] = [];
  const problems: string[] = [];
  const unmarked: { number: number; text: string }[] = [];
  const rows = text.split(/\r\n?|\n/).map((raw, index) => {
    const line = raw.trim();
    const number = index + 1;
    const section = HEADER.exec(line);
    let header = false;
    if (section && section[1].trim()) {
      sections.push(section[1].trim());
      header = true;
    } else if (line.includes('[') || line.includes(']')) {
      // Ошибочный заголовок не превращаем в строку песни даже при чтении старого файла.
      header = true;
      problems.push(lyricsTexts.invalidHeader({ number }));
    } else if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/.test(line)) {
      header = true;
      problems.push(lyricsTexts.markdown({ number }));
    } else if (SECTION_TITLE.test(line)) {
      header = true;
      unmarked.push({ number, text: line });
    }
    return { number, text: line, header };
  });
  const lines = rows.filter((row) => row.text && !row.header).length;
  if (!lines) problems.push(lyricsTexts.noLines);
  if (unmarked.length) {
    problems.push(
      lyricsTexts.unmarkedSections({
        titles: unmarked.map((row) => row.text),
        numbers: unmarked.map((row) => row.number),
        example: unmarked[0].text.replace(/[:.]$/, '')
      })
    );
  }
  return { rows, lines, sections, problems };
}

/** Старые тайминги после правки текста могут ссылаться на заголовки; такие строки не показываем как слова песни. */
export function selectLyricTimings(lines: TimingLine[], lyrics: LyricsLine[]): { lines: TimingLine[]; invalidIds: number[] } {
  const numbers = new Set(lyrics.filter((line) => line.text && !line.header).map((line) => line.number));
  return {
    lines: lines.filter((line) => numbers.has(line.source_line)),
    invalidIds: lines.filter((line) => !numbers.has(line.source_line)).map((line) => line.id)
  };
}
