/** Общий формат текста песни для формы, загрузки файла и редактора таймингов. */
import type { LyricsLine, TimingLine } from './types';

const HEADER = /^\[([^[\]]+)\]$/;
const SECTION_TITLE = /^(?:[а-яёa-z]+\s+){0,2}(?:припев|куплет|бридж|интро|вступление|аутро|проигрыш|кода|финал|запев)(?:\s+(?:[а-яёa-z]+|\d+)){0,2}[:.]?$/i;

export const LYRICS_FORMAT_HINT =
  'Одна исполняемая строка — на одной строке текста. Название секции — отдельно в квадратных скобках: [Куплет 1], [Припев]. Заголовки и пустые строки не размечаются. Повторы записывайте полностью в порядке исполнения.';

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
      problems.push(`Строка ${number}: заголовок секции должен быть отдельной строкой вида [Припев], с непустым названием и обеими скобками.`);
    } else if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/.test(line)) {
      header = true;
      problems.push(`Строка ${number}: уберите Markdown-разметку или нумерацию. Слова песни пишутся обычным текстом, секции — как [Припев].`);
    } else if (SECTION_TITLE.test(line)) {
      header = true;
      unmarked.push({ number, text: line });
    }
    return { number, text: line, header };
  });
  const lines = rows.filter((row) => row.text && !row.header).length;
  if (!lines) problems.push('В тексте песни нет ни одной строки. Добавьте слова песни под заголовком секции.');
  if (unmarked.length) {
    problems.push(
      `Похоже на названия частей без скобок: ${unmarked.map((row) => `«${row.text}»`).join(', ')} (строки ${unmarked.map((row) => row.number).join(', ')}). Оформите их как [${unmarked[0].text.replace(/[:.]$/, '')}].`
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
