import { animaticTexts } from '@shared/texts/animatic';
import { commonTexts } from '@shared/texts/common';
import { PageActionBar } from '../../components/PageActionBar';
import { usePageLoading } from '../../components/PageLoader';
import RefreshIcon from '@mui/icons-material/Refresh';
/** Страница аниматика объединяет сборку, просмотр планов и принятие результата. */

import type { ReactElement } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { JobStatus } from '../../components';
import { AnimaticAcceptance, AnimaticChapters, AnimaticConfirmDialog, AnimaticHeader, AnimaticPlayer, AnimaticProblems, ShotCard } from './components';
import { useAnimaticPage } from './useAnimaticPage';
import { LinkedText } from '../../components/LinkedText';

export function AnimaticPage(): ReactElement {
  const page = useAnimaticPage();
  const { view, loadError, load, loadJobs, running, accepted, shots, current, seek } = page;
  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={load}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );
  if (!view) return <></>;
  const built = view.built;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <AnimaticHeader
          built={built}
          accepted={accepted}
          running={running}
          runningJobId={page.runningJob?.id ?? null}
          blockedReason={view.blockedReason}
          onRefresh={() => Promise.all([load(), loadJobs()])}
          onBuild={page.build}
        />
      </PageActionBar>
      {/* Сбой последней сборки виден и после уведомления: причина и переход к её журналу. */}
      {page.failedJob && !running ? <JobStatus job={page.failedJob} /> : null}
      {/* Причины пересборки к идущей сборке уже не относятся: на её время список скрыт. */}
      {running ? null : <AnimaticProblems problems={view.problems} built={Boolean(built)} />}
      {built?.videoPath ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            '@container workspace (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start'
          }}
        >
          <AnimaticPlayer
            built={built}
            videoRef={page.videoRef}
            videoUrl={page.videoUrl}
            seekRequested={page.seekRequested}
            setTime={page.setTime}
            shots={shots}
            current={current}
            seek={seek}
            duration={page.duration}
            time={page.time}
            onOpenFolder={page.openFolder}
            onEngage={page.engage}
          />
          <Paper variant="outlined" sx={{ p: 2 }}>
            {current ? <ShotCard shot={current} /> : <Typography color="text.secondary">{animaticTexts.chooseShot}</Typography>}
          </Paper>
        </Box>
      ) : null}
      {built ? <AnimaticAcceptance built={built} accepted={accepted} approval={view.approval} running={running} onConfirm={page.setConfirm} /> : null}
      {shots.length ? <AnimaticChapters shots={shots} current={current} seek={seek} /> : null}
      <AnimaticConfirmDialog confirm={page.confirm} running={running} onClose={() => page.setConfirm(null)} onConfirm={page.setStatus} />
    </Stack>
  );
}
