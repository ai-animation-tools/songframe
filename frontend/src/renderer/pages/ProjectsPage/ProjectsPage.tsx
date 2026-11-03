import { Alert, Card, CardContent, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { workspaceTexts as text } from '@shared/texts/workspace';
import { methodAvailability } from '@platform/api';
import { ActionButton } from '../../components/ActionButton';
import { NativeDropZone } from '../../components/NativeDropZone';
import { PageActionBar } from '../../components/PageActionBar';

/** Открывает копию для просмотра; список текущего сеанса не записывается в старый профиль приложения. */
export function ProjectsPage({
  state,
  busy,
  onPick,
  onOpen,
  recent
}: {
  state: AppState;
  busy: boolean;
  onPick: () => void;
  onOpen: (path: string) => void;
  recent: { path: string; name: string }[];
}) {
  const create = methodAvailability('projects.create');
  return (
    <Stack spacing={3}>
      <PageActionBar title={shellTexts.projectsTitle}>
        <ActionButton startIcon={<AddIcon />} disabled={!create.available} disabledReason={create.reason}>
          {shellTexts.createProject}
        </ActionButton>
        <ActionButton variant="contained" startIcon={<FolderOpenIcon />} disabled={busy} onClick={onPick}>
          {busy ? text.opening : shellTexts.openProject}
        </ActionButton>
      </PageActionBar>
      <Typography color="text.secondary">{text.readOnlyHint}</Typography>
      {state.problems.map((problem, index) => (
        <Alert severity="warning" key={index}>
          {problem}
        </Alert>
      ))}
      <NativeDropZone id="project-drop" title={text.dropProject} hint={text.dropProjectHint} onPick={onPick} disabled={busy} />
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" component="h2">
            {shellTexts.recentProjects}
          </Typography>
          {recent.length === 0 ? (
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {shellTexts.emptyProjects}
            </Typography>
          ) : (
            <Stack spacing={2} sx={{ mt: 2 }}>
              {recent.map((item) => (
                <Stack key={item.path} spacing={1}>
                  <Typography sx={{ overflowWrap: 'anywhere' }}>{item.name}</Typography>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {item.path}
                  </Typography>
                  <ActionButton startIcon={<FolderOpenIcon />} disabled={busy} onClick={() => onOpen(item.path)}>
                    {text.openCopy}
                  </ActionButton>
                </Stack>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
