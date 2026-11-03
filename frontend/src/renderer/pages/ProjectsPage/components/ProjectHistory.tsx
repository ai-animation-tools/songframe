import { projectsTexts } from '@shared/texts/projects';
import type { ReactElement } from 'react';
import { Box, List, Paper, Typography } from '@mui/material';
import type { ProjectHistoryEntry, ProjectState } from '@shared/types';
import { ProjectHistoryRow } from './ProjectHistoryRow';

interface ProjectHistoryProps {
  history: ProjectHistoryEntry[];
  states: Record<string, ProjectState>;
  currentPath: string | null | undefined;
  busy: boolean;
  onOpen: (path: string) => void;
  onForget: (path: string) => void;
}

/** История отвечает за пустое состояние и передаёт каждой записи её вычисленный статус. */
export function ProjectHistory({ history, states, currentPath, busy, onOpen, onForget }: ProjectHistoryProps): ReactElement {
  return (
    <Paper variant="outlined">
      {history.length === 0 ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">{projectsTexts.emptyHistory}</Typography>
        </Box>
      ) : (
        // Сетка сохраняет порядок истории и переносит записи по фактической ширине рабочей области.
        <List
          disablePadding
          sx={{
            '@container workspace (min-width: 1100px)': {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))',
              gap: 1.5,
              p: 1.5,
              '& > li': { border: 1, borderColor: 'divider', borderRadius: 1 }
            }
          }}
        >
          {history.map((entry) => (
            <ProjectHistoryRow
              key={entry.path}
              entry={entry}
              projectState={states[entry.path]}
              current={currentPath === entry.path}
              busy={busy}
              onOpen={onOpen}
              onForget={onForget}
            />
          ))}
        </List>
      )}
    </Paper>
  );
}
