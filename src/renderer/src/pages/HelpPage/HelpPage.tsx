/** Справка доступна без проекта: объяснения ищутся по названиям, синонимам и содержанию. */
import { useState, type ReactElement } from 'react';
import { Alert, Box, InputAdornment, Paper, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { GLOSSARY } from './glossary';
import { GlossaryItem, HighlightedText } from './components';
import { searchGlossary } from './search';

export function HelpPage(): ReactElement {
  const [query, setQuery] = useState('');
  const { words, entries } = searchGlossary(GLOSSARY, query);
  const categories = [...new Set(entries.map((entry) => entry.category))];

  return (
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 1500, mx: 'auto', minWidth: 0 }}>
      <Box>
        <Typography variant="h5" component="h1" gutterBottom>
          Справка
        </Typography>
        <Typography color="text.secondary">
          Как начать работу над клипом и что означают действия в приложении. Ищите по названию, вопросу или знакомым словам.
        </Typography>
      </Box>
      <Box sx={{ position: 'sticky', top: 56, zIndex: 1, bgcolor: 'background.default', py: 1 }}>
        <TextField
          fullWidth
          type="search"
          label="Поиск по справке"
          placeholder="Например: с чего начать, стоимость, как перенести проект"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
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
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} aria-live="polite">
          {words.length ? `Найдено статей: ${entries.length} из ${GLOSSARY.length}` : `Всего статей: ${GLOSSARY.length}`}
        </Typography>
      </Box>
      {!entries.length ? <Alert severity="info">Ничего не найдено. Попробуйте другое слово или его часть.</Alert> : null}
      {categories.map((category) => (
        <Box component="section" key={category}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            <HighlightedText text={category} words={words} />
          </Typography>
          {/* Карточки заполняют доступную рабочую область и перестраиваются при изменении размера окна. */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'stretch', gap: 2 }}>
            {entries
              .filter((entry) => entry.category === category)
              .sort((left, right) => (left.id === 'getting-started' ? -1 : right.id === 'getting-started' ? 1 : left.term.localeCompare(right.term, 'ru')))
              .map((entry) => (
                <Paper key={entry.id} variant="outlined" sx={{ px: 2, minWidth: 0 }}>
                  <GlossaryItem entry={entry} words={words} />
                </Paper>
              ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
