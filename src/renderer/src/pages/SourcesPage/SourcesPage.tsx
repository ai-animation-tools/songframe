/** Исходники проекта: трек, текст песни, идея, обложка и референсы. */
import { useEffect, type ReactElement } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RefreshIcon from '@mui/icons-material/Refresh';
import { PageActionBar } from '../../components/PageActionBar';
import { CoverSection, IdeaSection, LyricsSection, ReferenceKindDialog, ReferencesSection, TrackSection } from './components';
import { useSourcesForm } from './useSourcesForm';

export function SourcesPage(): ReactElement {
  const form = useSourcesForm();
  useEffect(() => {
    // Файл, брошенный мимо области загрузки, не должен открыться вместо приложения.
    const preventNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  if (form.loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={form.retry}>
            Повторить
          </Button>
        }
      >
        {form.loadError}
      </Alert>
    );

  if (!form.view)
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );

  return (
    <Stack spacing={2} inert={form.busy || undefined} aria-busy={form.busy} sx={{ width: '100%', minWidth: 0, pb: 10 }}>
      <PageActionBar>
        <Typography variant="h5" sx={{ flex: 1 }}>
          Исходники
        </Typography>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={form.busy || form.hasPromptErrors || form.problems.length > 0 || form.lyricsCheck.problems.length > 0 || !form.dirty}
          onClick={form.save}
        >
          Сохранить
        </Button>
      </PageActionBar>
      {form.hasPromptErrors ? (
        <Alert severity="warning">
          Сохранение недоступно: не удалось прочитать некоторые промпты. Раскройте отмеченные референсы и восстановите файл либо введите текст заново.
        </Alert>
      ) : null}
      {form.view.problems.length ? <Alert severity="error">{form.view.problems.join(' ')}</Alert> : null}
      {form.problems.length ? (
        <Alert severity="warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {form.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {/* Референсы занимают отдельную колонку только при достаточной ширине рабочей области. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          alignItems: 'start',
          gap: 2,
          '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          '& > *': { minWidth: 0 }
        }}
      >
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {/* Внутренние карточки ориентируются на свою колонку, а не на ширину всего окна. */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
              gap: 2,
              '& > *': { minWidth: 0 }
            }}
          >
            <TrackSection {...form.trackProps} />
            <CoverSection {...form.coverProps} />
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
              gap: 2,
              '& > *': { minWidth: 0 }
            }}
          >
            <LyricsSection {...form.lyricsProps} />
            <IdeaSection {...form.ideaProps} />
          </Box>
        </Stack>
        <ReferencesSection {...form.referencesProps} />
      </Box>
      <ReferenceKindDialog {...form.kindDialogProps} />
    </Stack>
  );
}
