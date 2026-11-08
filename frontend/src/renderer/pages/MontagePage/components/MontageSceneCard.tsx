import { montageTexts } from '@shared/texts/montage';
import { Add } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { Box, ButtonBase, Chip, Paper, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { MontageClip, MontageScene, MontageSource } from '@shared/montage';
import { frameLabel } from '../model';
import { MontageSourceThumbnail } from './MontageSourceThumbnail';
import { materialColor, MontageMaterialChip } from './MontageMaterialChip';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import SwapHoriz from '@mui/icons-material/SwapHoriz';

/** Карточка объединяет варианты сцены; у каждого материала своё превью и действие добавления. */
export function MontageSceneCard({
  project,
  scene,
  sources,
  used,
  selectedClipId,
  onSelectClip,
  onPreview,
  onAdd
}: {
  project: string;
  scene: MontageScene;
  sources: MontageSource[];
  used?: MontageClip;
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  onPreview: (source: MontageSource) => void;
  onAdd: (id: string) => void;
}): ReactElement {
  const selectedScene = used?.id === selectedClipId;

  return (
    <Paper variant="outlined" sx={{ minWidth: 0, p: 1.5, borderColor: selectedScene ? 'primary.main' : 'divider', overflowWrap: 'anywhere' }}>
      <ButtonBase
        disabled={!used}
        onClick={() => used && onSelectClip(used.id)}
        // Имя кнопки складывается из видимых кода, названия и длительности сцены (WCAG 2.5.3); действие — в подсказке.
        title={used ? montageTexts.selectScene(scene.id) : undefined}
        sx={{
          display: 'block',
          textAlign: 'left',
          width: '100%',
          borderRadius: 0.5,
          '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between">
          <Typography variant="overline" color={used ? 'primary.main' : 'text.secondary'} lineHeight={1.5} fontWeight={700}>
            {scene.id}
          </Typography>
          {used ? <Chip size="small" color="primary" variant="outlined" label={montageTexts.onTrack} /> : null}
        </Stack>
        <Typography variant="body2" fontWeight={600} sx={{ mt: 0.5 }}>
          {scene.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {montageTexts.scenarioDuration(frameLabel(scene.endFrame - scene.startFrame))}
        </Typography>
      </ButtonBase>
      {!sources.length ? (
        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1 }}>
          {montageTexts.noMaterial}
        </Typography>
      ) : null}
      <Stack spacing={1} sx={{ mt: sources.length ? 1.5 : 0 }}>
        {sources.map((source) => {
          const selected = used?.path === source.path;
          const color = materialColor(source);
          return (
            <Box
              key={source.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-songframe-montage-source', source.id);
                event.dataTransfer.effectAllowed = used ? 'link' : 'copy';
              }}
              sx={{
                p: 1,
                border: 1,
                borderColor: selected ? 'primary.main' : color ? `${color}.main` : 'divider',
                borderWidth: source.attempt ? 2 : 1,
                // Цвет всего материала различает полный оригинал и принятый монтаж в обеих темах.
                bgcolor: (theme) =>
                  color
                    ? alpha(
                        theme.palette[color].main,
                        source.attempt ? (theme.palette.mode === 'dark' ? 0.32 : 0.2) : theme.palette.mode === 'dark' ? 0.18 : 0.09
                      )
                    : 'background.default',
                borderRadius: 1,
                cursor: 'grab',
                '&:active': { cursor: 'grabbing' }
              }}
            >
              <MontageSourceThumbnail
                project={project}
                source={source}
                sceneLabel={montageTexts.sceneTitle({ scene: scene.id, title: scene.title })}
                onOpen={() => onPreview(source)}
              />
              <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                <MontageMaterialChip source={source} />
                <Typography variant="caption" color="text.secondary">
                  {source.kind === 'card' ? montageTexts.cardSource : source.frames === null ? montageTexts.readingLength : frameLabel(source.frames)}
                </Typography>
              </Stack>
              <Typography variant="caption" display="block" sx={{ my: 0.75 }} title={source.path}>
                {source.label}
              </Typography>
              {used && !selected ? (
                // Залитая кнопка: текст error не держит 4.5:1 на цветном фоне материала, а contrastText темы держит.
                <DestructiveButton
                  variant="contained"
                  label={montageTexts.replaceCurrent}
                  description={montageTexts.replaceDescription({ scene: scene.id, label: source.label })}
                  confirmLabel={montageTexts.replaceOnTrack}
                  startIcon={<SwapHoriz />}
                  onConfirm={() => onAdd(source.id)}
                />
              ) : (
                <ActionButton
                  startIcon={<Add />}
                  color="success"
                  size="small"
                  disabled={selected}
                  disabledReason={montageTexts.alreadyOnTrack}
                  onClick={() => onAdd(source.id)}
                  sx={{ px: 0.5 }}
                >
                  {selected ? montageTexts.onTrack : montageTexts.add}
                </ActionButton>
              )}
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}
