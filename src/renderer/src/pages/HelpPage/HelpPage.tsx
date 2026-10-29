/** Справка доступна без проекта: объяснения ищутся по названиям, синонимам и содержанию. */
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
          Справка
        </Typography>
        <TextField
          size="small"
          type="search"
          label="Поиск по справке"
          placeholder="Например: с чего начать, стоимость, как перенести проект"
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
          {words.length ? `Найдено статей: ${entries.length} из ${GLOSSARY.length}` : `Всего статей: ${GLOSSARY.length}`}
        </Typography>
      </PageActionBar>
      <Typography color="text.secondary">
        Как начать работу над клипом и что означают действия в приложении. Ищите по названию, вопросу или знакомым словам.
      </Typography>
      {!entries.length ? <Alert severity="info">Ничего не найдено. Попробуйте другое слово или его часть.</Alert> : null}
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
