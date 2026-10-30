/** Короткое объяснение термина и пример его использования в работе над клипом. */
import { helpTexts } from '@shared/texts/help';
import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import type { GlossaryEntry } from '../glossary';
import { searchable } from '../search';
import { HighlightedText } from './HighlightedText';
import { LinkedText } from '../../../components/LinkedText';
import { SlottedText } from '../../../components/SlottedText';

export function GlossaryItem({ entry, words }: { entry: GlossaryEntry; words: string[] }): ReactElement {
  const visible = searchable([entry.term, entry.category, entry.description, entry.example ?? ''].join(' '));
  // Если совпал только скрытый синоним, показываем его, чтобы причина результата была видна.
  // Названия страниц и блоков в кавычках ведут к ним; найденные слова подсвечиваются и внутри ссылок.
  const highlight = (text: string): ReactElement => <HighlightedText text={text} words={words} />;
  const aliases = entry.aliases.filter((alias) => words.some((word) => !visible.includes(word) && searchable(alias).includes(word)));
  return (
    <Box component="article" id={entry.id} sx={{ py: 2, scrollMarginTop: 160 }}>
      <Typography variant="subtitle1" component="h3" fontWeight={600} gutterBottom>
        <HighlightedText text={entry.term} words={words} />
      </Typography>
      {aliases.length ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          <SlottedText text={helpTexts.aliases} slots={{ aliases: <HighlightedText text={aliases.join(', ')} words={words} /> }} />
        </Typography>
      ) : null}
      <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
        <LinkedText text={entry.description} renderText={highlight} />
      </Typography>
      {entry.example ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          <SlottedText text={helpTexts.example} slots={{ example: <LinkedText text={entry.example} renderText={highlight} /> }} />
        </Typography>
      ) : null}
    </Box>
  );
}
