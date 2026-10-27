/** Выделяет буквальные совпадения без вставки HTML; пересекающиеся фрагменты объединяются. */
import type { ReactElement, ReactNode } from 'react';
import { Box } from '@mui/material';
import { searchable } from '../search';

export function HighlightedText({ text, words }: { text: string; words: string[] }): ReactElement {
  const normalized = searchable(text);
  const ranges: { start: number; end: number }[] = [];
  for (const word of words) {
    if (!word) continue;
    let start = normalized.indexOf(word);
    while (start >= 0) {
      ranges.push({ start, end: start + word.length });
      start = normalized.indexOf(word, start + 1);
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of merged) {
    parts.push(text.slice(cursor, range.start));
    parts.push(
      <Box
        component="mark"
        key={range.start}
        sx={(theme) => ({
          bgcolor: theme.palette.warning.light,
          color: theme.palette.getContrastText(theme.palette.warning.light),
          borderRadius: 0.5
        })}
      >
        {text.slice(range.start, range.end)}
      </Box>
    );
    cursor = range.end;
  }
  return (
    <>
      {parts}
      {text.slice(cursor)}
    </>
  );
}
