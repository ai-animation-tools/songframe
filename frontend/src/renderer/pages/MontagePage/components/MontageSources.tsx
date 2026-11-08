import { montageTexts } from '@shared/texts/montage';
import { memo, useState, type ReactElement } from 'react';
import { Alert, Box, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import type { MontageClip, MontageScene, MontageSource } from '@shared/montage';
import { MontageSceneCard } from './MontageSceneCard';
import { matchesWords, searchWords } from '../../../components/searchText';

/** Каталог сохраняет выбор при открытии панели; ширина её содержимого определяет число колонок. */
export const MontageSources = memo(function MontageSources({
  project,
  sources,
  scenes,
  clips,
  selectedClipId,
  onSelectClip,
  onPreview,
  onAdd
}: {
  project: string;
  sources: MontageSource[];
  scenes: MontageScene[];
  clips: MontageClip[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  onPreview: (source: MontageSource) => void;
  onAdd: (id: string) => void;
}): ReactElement {
  const availableScenes = new Set(sources.map((source) => source.scene)).size;
  const [query, setQuery] = useState('');
  const words = searchWords(query);
  // Живой поиск по коду и названию сцены и по подписям её материалов; все слова запроса должны найтись.
  const shown = words.length
    ? scenes.filter((scene) =>
        matchesWords(
          [scene.id, scene.title, ...sources.filter((source) => source.scene === scene.id).flatMap((source) => [source.title, source.label])].join(' '),
          words
        )
      )
    : scenes;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <Stack spacing={0.5} sx={{ p: 2, pr: 7, pb: 1.5 }}>
        <Stack direction="row" gap={1} justifyContent="space-between" alignItems="baseline" flexWrap="wrap">
          <Typography id="montage-sources-title" variant="h6">
            {montageTexts.sceneMaterials}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {montageTexts.availableScenes({ available: availableScenes, total: scenes.length })}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.primary">
          {montageTexts.sourcesHint}
        </Typography>
        <TextField
          size="small"
          type="search"
          label={montageTexts.searchScene}
          placeholder={montageTexts.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ mt: 1 }}
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
        {words.length ? (
          <Typography variant="caption" color="text.secondary" aria-live="polite">
            {montageTexts.foundScenes({ found: shown.length, total: scenes.length })}
          </Typography>
        ) : null}
      </Stack>
      <Box sx={{ px: 2, pb: 2, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            // Колонки учитывают отступы и полосу прокрутки; на узком экране карточка сжимается до ширины каталога.
            // auto-fill сохраняет пустые колонки: найденные поиском карточки не растягиваются на всю панель.
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
            gap: 1.5,
            alignItems: 'start'
          }}
        >
          {shown.map((scene) => (
            <MontageSceneCard
              key={scene.id}
              project={project}
              scene={scene}
              sources={sources.filter((source) => source.scene === scene.id)}
              used={clips.find((clip) => clip.scene === scene.id)}
              selectedClipId={selectedClipId}
              onSelectClip={onSelectClip}
              onPreview={onPreview}
              onAdd={onAdd}
            />
          ))}
        </Box>
        {words.length && !shown.length ? <Alert severity="info">{montageTexts.nothingFound}</Alert> : null}
      </Box>
    </Box>
  );
});
