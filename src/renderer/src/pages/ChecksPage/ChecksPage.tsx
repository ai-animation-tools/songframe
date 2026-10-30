/** Панель проверок: инструменты комплекса, проба стыков и текущие результаты. */

import { checksTexts } from '@shared/texts/checks';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { JobStatus } from '../../components';
import { ProjectChecksPanel, ReviewPanel } from './components';
import { useChecksPage } from './useChecksPage';
import { PageActionBar } from '../../components/PageActionBar';
import { LinkedText } from '../../components/LinkedText';

export function ChecksPage(): ReactElement {
  const page = useChecksPage();
  // Причины блокировки общие для проверок и пробы; показываются в подсказках выключенных кнопок.
  const toolsReason = !page.pythonAvailable ? checksTexts.pythonRequired : page.running ? checksTexts.jobPending : null;
  const checksReason = toolsReason ?? (!page.scenesReady ? checksTexts.scenesRequired : null);

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5">{navigationTexts.pages.checks}</Typography>
        {/* Индикатор задания стоит в закреплённой панели, чтобы был виден при любой прокрутке. */}
        <JobStatus running={page.running} />
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<RefreshIcon />} onClick={() => Promise.all([page.loadJobs(), page.loadReviews()])}>
          {commonTexts.refresh}
        </Button>
      </PageActionBar>
      {!page.pythonAvailable ? (
        <Alert severity="warning">
          <LinkedText text={checksTexts.pythonUnavailable} />
        </Alert>
      ) : null}
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
          disabledReason={checksReason}
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
          disabledReason={toolsReason}
          reviews={page.reviews}
          openReview={page.openReview}
          deletingReview={page.deletingReview}
          setPlanOnly={page.setPlanOnly}
          toggleShot={page.toggleShot}
          clearSelection={page.clearSelection}
          buildReview={page.buildReview}
          setOpenReview={page.setOpenReview}
          openDirectory={page.openDirectory}
          removeReview={page.removeReview}
        />
      </Box>
    </Stack>
  );
}
