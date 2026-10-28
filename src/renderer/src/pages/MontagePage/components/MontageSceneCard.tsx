import { Add } from '@mui/icons-material';
import type { ReactElement } from 'react';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import { Box, ButtonBase, Chip, Paper, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { MontageClip, MontageScene, MontageSource } from '@shared/montage';
import { frameLabel } from '../model';
import { MontageSourceThumbnail } from './MontageSourceThumbnail';
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
        aria-label={`Выбрать сцену ${scene.id}`}
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
          {used ? <Chip size="small" color="primary" variant="outlined" label="На дорожке" /> : null}
        </Stack>
        <Typography variant="body2" fontWeight={600} sx={{ mt: 0.5 }}>
          {scene.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          По сценарию: {frameLabel(scene.endFrame - scene.startFrame)}
        </Typography>
      </ButtonBase>
      {!sources.length ? (
        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1 }}>
          Нет доступного материала
        </Typography>
      ) : null}
      <Stack spacing={1} sx={{ mt: sources.length ? 1.5 : 0 }}>
        {sources.map((source) => {
          const selected = used?.path === source.path;
          // Результат попытки выделяется предупреждающим цветом: он ещё не принят и легко теряется среди принятых материалов.
          const materialColor = source.kind === 'card' ? null : source.attempt ? 'warning' : source.original ? 'info' : 'success';
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
                borderColor: selected ? 'primary.main' : materialColor ? `${materialColor}.main` : 'divider',
                borderWidth: source.attempt ? 2 : 1,
                // Цвет всего материала различает полный оригинал и принятый монтаж в обеих темах.
                bgcolor: (theme) =>
                  materialColor
                    ? alpha(
                        theme.palette[materialColor].main,
                        source.attempt ? (theme.palette.mode === 'dark' ? 0.32 : 0.2) : theme.palette.mode === 'dark' ? 0.18 : 0.09
                      )
                    : 'background.default',
                borderRadius: 1,
                cursor: 'grab',
                '&:active': { cursor: 'grabbing' }
              }}
            >
              <MontageSourceThumbnail project={project} source={source} sceneLabel={`${scene.id} — ${scene.title}`} onOpen={() => onPreview(source)} />
              <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">
                {source.kind === 'card' ? <ImageOutlinedIcon fontSize="small" color="action" /> : <MovieOutlinedIcon fontSize="small" color="action" />}
                <Chip
                  size="small"
                  label={source.kind === 'card' ? 'Карточка' : source.attempt ? 'Не принят' : source.original ? 'Полный оригинал' : 'Принятый'}
                  color={materialColor ?? 'default'}
                  variant={source.attempt ? 'filled' : 'outlined'}
                />
                <Typography variant="caption" color="text.secondary">
                  {source.kind === 'card' ? 'Опора' : source.frames === null ? 'Читаем длину…' : frameLabel(source.frames)}
                </Typography>
              </Stack>
              <Typography variant="caption" display="block" sx={{ my: 0.75 }} title={source.path}>
                {source.label}
              </Typography>
              {used && !selected ? (
                <DestructiveButton
                  label="Заменить текущий"
                  description={`На дорожке сцены ${scene.id} текущий вариант будет заменён на «${source.label}». Обрезка начнётся заново с начала выбранного материала; если он короче, фрагмент на дорожке станет короче. Исходные файлы сохранятся, замену можно отменить.`}
                  confirmLabel="Заменить на дорожке"
                  startIcon={<SwapHoriz />}
                  onConfirm={() => onAdd(source.id)}
                />
              ) : (
                <ActionButton
                  startIcon={<Add />}
                  color="success"
                  size="small"
                  disabled={selected}
                  disabledReason="Этот материал уже стоит на дорожке."
                  onClick={() => onAdd(source.id)}
                  sx={{ px: 0.5 }}
                >
                  {selected ? 'На дорожке' : 'Добавить'}
                </ActionButton>
              )}
            </Box>
          );
        })}
      </Stack>
    </Paper>
  );
}
