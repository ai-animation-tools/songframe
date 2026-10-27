import { PageActionBar } from '../../components/PageActionBar';
import RefreshIcon from '@mui/icons-material/Refresh';
/** Страница аниматика объединяет сборку, просмотр планов и принятие результата. */

import type { ReactElement } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { JobStatus } from '../../components';
import { AnimaticAcceptance, AnimaticChapters, AnimaticConfirmDialog, AnimaticHeader, AnimaticPlayer, ShotCard } from './components';
import { useAnimaticPage } from './useAnimaticPage';

export function AnimaticPage(): ReactElement {
  const page = useAnimaticPage();
  const { view, loadError, load, loadJobs, running, accepted, shots, current, seek } = page;
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={load}>
            Повторить
          </Button>
        }
      >
        {loadError}
      </Alert>
    );
  if (!view) return <Typography color="text.secondary">Читаем сборку…</Typography>;
  const built = view.built;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <AnimaticHeader built={built} accepted={accepted} running={running} onRefresh={() => Promise.all([load(), loadJobs()])} onBuild={page.build} />
      </PageActionBar>
      {view.problems.length ? (
        <Alert severity={built ? 'warning' : 'info'}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {view.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
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
          />
          <Paper variant="outlined" sx={{ p: 2 }}>
            {current ? <ShotCard shot={current} /> : <Typography color="text.secondary">Запустите видео или выберите план на полосе глав.</Typography>}
          </Paper>
        </Box>
      ) : null}
      {built ? <AnimaticAcceptance built={built} accepted={accepted} approval={view.approval} running={running} onConfirm={page.setConfirm} /> : null}
      {shots.length ? <AnimaticChapters shots={shots} current={current} seek={seek} /> : null}
      <JobStatus running={running} />
      <AnimaticConfirmDialog confirm={page.confirm} running={running} onClose={() => page.setConfirm(null)} onConfirm={page.setStatus} />
    </Stack>
  );
}
