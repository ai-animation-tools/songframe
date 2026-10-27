import ClearIcon from '@mui/icons-material/Clear';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import VisibilityIcon from '@mui/icons-material/Visibility';
/** Пользователь выбирает файл для каждого ID опоры; импорт не подменяет последующее согласование кадров. */
import { useState, type ReactElement } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { ProductionFrameCandidate, ProductionFramePrompt } from '@shared/production-workflow';
import { useApp } from '../../../state';

export function ProductionFrameImport({
  frames,
  busy,
  onImport
}: {
  frames: ProductionFramePrompt[];
  busy: boolean;
  onImport(images: ProductionFrameCandidate[]): Promise<boolean>;
}): ReactElement | null {
  const { notify, describeError } = useApp();
  const [paths, setPaths] = useState<Record<string, string>>({});
  if (!frames.length) return null;
  const choose = async (id: string): Promise<void> => {
    try {
      const files = await window.api.dialog.pickFiles({
        title: `Изображение опоры ${id}`,
        multiple: false,
        filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (files[0]) setPaths((current) => ({ ...current, [id]: files[0] }));
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  return (
    <Box component="details">
      <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>
        Импортировать свои опоры PNG, JPG, WebP
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {frames.map((frame) => (
          <Stack key={frame.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button startIcon={<FolderOpenIcon />} size="small" disabled={busy} onClick={() => void choose(frame.id)}>
              Выбрать {frame.id}
            </Button>
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {frame.role} · {frame.timeSeconds} с · {paths[frame.id] ?? 'Файл не выбран'}
            </Typography>
          </Stack>
        ))}
        <Stack direction="row" spacing={1}>
          <Button
            startIcon={<VisibilityIcon />}
            disabled={busy || !frames.every((frame) => paths[frame.id])}
            onClick={async () => {
              if (await onImport(frames.map((frame) => ({ id: frame.id, path: paths[frame.id] })))) setPaths({});
            }}
          >
            Показать кандидаты
          </Button>
          <Button startIcon={<ClearIcon />} disabled={busy || !Object.keys(paths).length} onClick={() => setPaths({})}>
            Очистить выбор
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
