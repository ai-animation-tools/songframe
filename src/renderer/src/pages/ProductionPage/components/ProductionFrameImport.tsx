import ClearIcon from '@mui/icons-material/Clear';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import VisibilityIcon from '@mui/icons-material/Visibility';
/** Свои файлы выбираются для любых неутверждённых опор, хоть для одной; остальные агент создаст по одной. Импорт не подменяет согласование кадров. */
import { useState, type ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { ProductionFrameCandidate, ProductionFramePrompt } from '@shared/production-workflow';
import { useApp } from '../../../state';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';

export function ProductionFrameImport({
  frames,
  busy,
  busyReason = BUSY_REASON,
  onImport
}: {
  frames: ProductionFramePrompt[];
  busy: boolean;
  /** Почему busy блокирует импорт: идёт операция или этап пакета не принимает опоры. */
  busyReason?: string;
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
        <Typography variant="caption" color="text.secondary">
          Выберите файлы только для нужных опор. Каждая получит свой вопрос об утверждении; недостающие агент создаст по одной, учитывая утверждённые.
        </Typography>
        {frames.map((frame) => (
          <Stack key={frame.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ActionButton startIcon={<FolderOpenIcon />} size="small" disabled={busy} disabledReason={busyReason} onClick={() => void choose(frame.id)}>
              Выбрать {frame.id}
            </ActionButton>
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {frame.role} · {frame.timeSeconds} с · {paths[frame.id] ?? 'Файл не выбран'}
            </Typography>
          </Stack>
        ))}
        <Stack direction="row" spacing={1}>
          <ActionButton
            startIcon={<VisibilityIcon />}
            disabled={busy || !frames.some((frame) => paths[frame.id])}
            disabledReason={busy ? busyReason : 'Выберите файл хотя бы для одной опоры.'}
            onClick={async () => {
              // Порядок кандидатов — порядок плана, как требует главный процесс.
              const chosen = frames.filter((frame) => paths[frame.id]).map((frame) => ({ id: frame.id, path: paths[frame.id] }));
              if (await onImport(chosen)) setPaths({});
            }}
          >
            Показать кандидаты
          </ActionButton>
          <ActionButton
            startIcon={<ClearIcon />}
            disabled={busy || !Object.keys(paths).length}
            disabledReason={busy ? busyReason : 'Файлы ещё не выбраны.'}
            onClick={() => setPaths({})}
          >
            Очистить выбор
          </ActionButton>
        </Stack>
      </Stack>
    </Box>
  );
}
