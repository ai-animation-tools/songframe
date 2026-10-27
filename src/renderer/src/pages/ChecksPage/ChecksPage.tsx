/** Панель проверок: инструменты комплекса, проба стыков и текущие результаты. */

import type { ReactElement } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { JobStatus } from '../../components';
import { ProjectChecksPanel, ReviewPanel } from './components';
import { useChecksPage } from './useChecksPage';
import { PageActionBar } from '../../components/PageActionBar';

export function ChecksPage(): ReactElement {
  const page = useChecksPage();

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5">Проверки</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => Promise.all([page.loadJobs(), page.loadReviews()])}>
          Обновить
        </Button>
      </PageActionBar>
      {!page.pythonAvailable ? <Alert severity="warning">Python не найден: проверки и проба недоступны. См. страницу «Среда».</Alert> : null}
      {/* Независимые проверки и проба стыков стоят рядом, когда рабочая область достаточно широка. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 2,
          alignItems: 'start',
          '& > *': { minWidth: 0 }
        }}
      >
        <ProjectChecksPanel
          checks={page.checks}
          disabled={!page.pythonAvailable || !page.scenesReady || page.running}
          strict={page.strict}
          next={page.next}
          setStrict={page.setStrict}
          setNext={page.setNext}
          runAll={page.runAll}
          outcome={page.outcome}
          updateViews={page.updateViews}
          runCheck={page.runCheck}
        />
        <ReviewPanel
          shots={page.shots}
          selected={page.selected}
          planOnly={page.planOnly}
          disabled={!page.pythonAvailable || page.running}
          reviews={page.reviews}
          openReview={page.openReview}
          deletingReview={page.deletingReview}
          setPlanOnly={page.setPlanOnly}
          toggleShot={page.toggleShot}
          clearSelection={() => page.setSelected([])}
          buildReview={page.buildReview}
          setOpenReview={page.setOpenReview}
          openDirectory={page.openDirectory}
          removeReview={page.removeReview}
        />
      </Box>
      <JobStatus running={page.running} />
    </Stack>
  );
}
