import type { ReactElement } from 'react';
import { Box, ListItem, ListItemButton, ListItemText, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { ProjectHistoryEntry, ProjectState } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { StateChip } from '../../../components';
import { formatDateTime } from '../../../format';

interface ProjectHistoryRowProps {
  entry: ProjectHistoryEntry;
  projectState: ProjectState | undefined;
  current: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onForget: (path: string) => void;
}

/** Запись показывает доступность папки и статус проекта, сохраняя общую блокировку действий. */
export function ProjectHistoryRow({ entry, projectState, current, busy, onOpen, onForget }: ProjectHistoryRowProps): ReactElement {
  return (
    <ListItem
      divider
      disablePadding
      sx={{ minWidth: 0 }}
      secondaryAction={
        <DestructiveButton
          icon
          label={`Убрать проект «${entry.name}» из истории`}
          description="Из истории будет удалена только запись о проекте. Папка проекта и все её файлы останутся на диске."
          disabled={busy}
          onConfirm={() => onForget(entry.path)}
          confirmLabel="Убрать из истории"
        >
          <DeleteOutlineIcon fontSize="small" />
        </DestructiveButton>
      }
    >
      <ListItemButton disabled={!entry.exists || busy} onClick={() => onOpen(entry.path)} sx={{ py: 1.25, minWidth: 0 }}>
        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Typography fontWeight={600}>{entry.name}</Typography>
              {entry.exists ? projectState ? <StateChip state={projectState} size="small" /> : null : <StateChip state="invalid" size="small" />}
              {current ? (
                <Typography variant="caption" color="primary">
                  текущий
                </Typography>
              ) : null}
            </Box>
          }
          slotProps={{ secondary: { sx: { overflowWrap: 'anywhere' } } }}
          secondary={`${entry.path}${entry.exists ? '' : ' (папка не найдена)'}${entry.lastOpened ? ` · открыт ${formatDateTime(entry.lastOpened)}` : ''}`}
        />
      </ListItemButton>
    </ListItem>
  );
}
