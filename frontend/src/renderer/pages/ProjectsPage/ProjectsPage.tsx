import { Alert, Box, Card, CardContent, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { methodAvailability } from '@platform/api';
import { ActionButton } from '../../components/ActionButton';

/** Начальная страница читает только снимок оболочки; создание и открытие появятся вместе с Go-доменом проектов. */
export function ProjectsPage({ state }: { state: AppState }) {
  const create = methodAvailability('projects.create');
  const open = methodAvailability('projects.open');
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" component="h1">
          {shellTexts.projectsTitle}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          {shellTexts.projectsDescription}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
        <ActionButton variant="contained" color="success" startIcon={<AddIcon />} disabled={!create.available} disabledReason={create.reason}>
          {shellTexts.createProject}
        </ActionButton>
        <ActionButton variant="outlined" startIcon={<FolderOpenIcon />} disabled={!open.available} disabledReason={open.reason}>
          {shellTexts.openProject}
        </ActionButton>
      </Stack>
      {state.problems.map((problem, index) => (
        <Alert severity="warning" key={index}>
          {problem}
        </Alert>
      ))}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            {shellTexts.recentProjects}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {shellTexts.emptyProjects}
          </Typography>
        </CardContent>
      </Card>
    </Stack>
  );
}
