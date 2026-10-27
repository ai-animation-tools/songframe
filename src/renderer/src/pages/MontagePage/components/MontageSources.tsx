import { memo, type ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { MontageClip, MontageScene, MontageSource } from '@shared/montage';
import { MontageSceneCard } from './MontageSceneCard';

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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <Stack spacing={0.5} sx={{ p: 2, pr: 7, pb: 1.5 }}>
        <Stack direction="row" gap={1} justifyContent="space-between" alignItems="baseline" flexWrap="wrap">
          <Typography id="montage-sources-title" variant="h6">
            Материалы сцен
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Доступно {availableScenes} из {scenes.length} сцен
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Добавьте материал на дорожку или замените выбранный вариант кнопкой. Полный оригинал даёт запас за границами принятого монтажа.
        </Typography>
      </Stack>
      <Box sx={{ px: 2, pb: 2, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            // Колонки учитывают отступы и полосу прокрутки; на узком экране карточка сжимается до ширины каталога.
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: 1.5,
            alignItems: 'start'
          }}
        >
          {scenes.map((scene) => (
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
      </Box>
    </Box>
  );
});
