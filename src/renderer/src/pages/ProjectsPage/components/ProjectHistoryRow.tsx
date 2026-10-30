import { projectsTexts } from '@shared/texts/projects';
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
          label={projectsTexts.forget({ name: entry.name })}
          description={projectsTexts.forgetDescription}
          disabled={busy}
          disabledReason={projectsTexts.opening}
          onConfirm={() => onForget(entry.path)}
          confirmLabel={projectsTexts.forgetConfirm}
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
                  {projectsTexts.current}
                </Typography>
              ) : null}
            </Box>
          }
          slotProps={{ secondary: { sx: { overflowWrap: 'anywhere' } } }}
          secondary={projectsTexts.historyDetails({
            path: entry.path,
            exists: entry.exists,
            openedAt: entry.lastOpened ? formatDateTime(entry.lastOpened) : undefined
          })}
        />
      </ListItemButton>
    </ListItem>
  );
}
