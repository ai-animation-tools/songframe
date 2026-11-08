/** Справка доступна без проекта: объяснения ищутся по названиям, синонимам и содержанию. */
import { helpTexts } from '@shared/texts/help';
import { navigationTexts } from '@shared/texts/navigation';
import { useState, type ReactElement } from 'react';
import { Alert, Box, InputAdornment, Paper, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { GLOSSARY } from './glossary';
import { GlossaryItem, HighlightedText } from './components';
import { searchGlossary } from './search';
import { PageActionBar } from '../../components/PageActionBar';

export function HelpPage(): ReactElement {
  const [query, setQuery] = useState('');
  const { words, entries } = searchGlossary(GLOSSARY, query);
  const categories = [...new Set(entries.map((entry) => entry.category))];

  return (
    // Справка занимает всю рабочую область, как остальные страницы: на широком экране просто больше колонок статей.
    <Stack spacing={3} sx={{ width: '100%', minWidth: 0 }}>
      {/* Заголовок и поиск в общей панели страницы: поиск доступен при любой прокрутке. */}
      <PageActionBar>
        <Typography variant="h5" component="h1">
          {navigationTexts.pages.help}
        </Typography>
        <TextField
          size="small"
          type="search"
          label={helpTexts.search}
          placeholder={helpTexts.searchExample}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ flex: 1, minWidth: 260 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              )
            }
          }}
        />
        <Typography variant="body2" color="text.secondary" aria-live="polite">
          {words.length ? helpTexts.found({ count: entries.length, total: GLOSSARY.length }) : helpTexts.total(GLOSSARY.length)}
        </Typography>
      </PageActionBar>
      <Typography color="text.secondary">{helpTexts.description}</Typography>
      {!entries.length ? <Alert severity="info">{helpTexts.empty}</Alert> : null}
      {categories.map((category) => (
        <Box component="section" key={category}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            <HighlightedText text={category} words={words} />
          </Typography>
          {/* Колонки «кирпичной кладкой»: каждая карточка своей высоты, длинная статья не растягивает соседние. */}
          <Box sx={{ columnWidth: 340, columnGap: 2 }}>
            {entries
              .filter((entry) => entry.category === category)
              .sort((left, right) => (left.id === 'getting-started' ? -1 : right.id === 'getting-started' ? 1 : left.term.localeCompare(right.term, 'ru')))
              .map((entry) => (
                <Paper key={entry.id} variant="outlined" sx={{ px: 2, minWidth: 0, mb: 2, breakInside: 'avoid', display: 'inline-block', width: '100%' }}>
                  <GlossaryItem entry={entry} words={words} />
                </Paper>
              ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
