/** Единая хронология сохраняет штатные карточки и операции двух разных API заданий. */
import { useEffect, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Chip, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import type { AgentJob } from '@shared/agents';
import { AgentJobCard } from '../../components/AgentJobCard';
import { AgentRetryDialog } from '../../components/AgentRetryDialog';
import { JobCard } from '../../components/JobCard';
import { useApp } from '../../state';
import { useJobsJournal } from './useJobsJournal';

export function JobsPage(): ReactElement {
  const { state } = useApp();
  const journal = useJobsJournal();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('job');
  const [scope, setScope] = useState('current');
  const [retry, setRetry] = useState<AgentJob | null>(null);
  const entries = [...journal.tools.map((job) => ({ type: 'tool' as const, job })), ...journal.agents.map((job) => ({ type: 'agent' as const, job }))].sort(
    (a, b) => b.job.startedAt.localeCompare(a.job.startedAt)
  );
  const projects = [
    ...new Set([...(state?.history.map((project) => project.path) ?? []), ...entries.flatMap(({ job }) => (job.project ? [job.project] : []))])
  ];
  const projectName = (path: string): string => state?.history.find((project) => project.path === path)?.name ?? path;
  const selectedEntry = entries.find(({ job }) => job.id === selectedId);
  // Прямая ссылка выбирает проект записи; ручной выбор фильтра снимает привязку к ней.
  const selectedScope = selectedEntry ? (selectedEntry.job.project === state?.current ? 'current' : (selectedEntry.job.project ?? 'global')) : scope;
  const project = selectedScope === 'current' ? state?.current : selectedScope;
  const visible = entries.filter(({ job }) => selectedScope === 'all' || (selectedScope === 'global' ? !job.project : !job.project || job.project === project));
  const selectedVisible = visible.some(({ job }) => job.id === selectedId);

  useEffect(() => {
    // Прямой переход с рабочей страницы прокручивает хронологию к нужной записи.
    if (selectedId && selectedVisible) document.getElementById(`job-${selectedId}`)?.scrollIntoView({ block: 'center' });
  }, [selectedId, selectedVisible]);

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5">Журнал заданий</Typography>
        <TextField
          select
          size="small"
          label="Проект"
          value={selectedScope}
          onChange={(event) => {
            setScope(event.target.value);
            setParams({}, { replace: true });
          }}
          sx={{ minWidth: 240, maxWidth: '100%' }}
        >
          <MenuItem value="current">{state?.current ? `Текущий: ${projectName(state.current)}` : 'Общие задания приложения'}</MenuItem>
          <MenuItem value="all">Все проекты</MenuItem>
          <MenuItem value="global">Только общие задания приложения</MenuItem>
          {projects
            .filter((path) => path !== state?.current)
            .map((path) => (
              <MenuItem key={path} value={path}>
                {projectName(path)}
              </MenuItem>
            ))}
        </TextField>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Инструменты и агенты в порядке запуска, новые сверху. Общие задания приложения видны вместе с заданиями выбранного проекта. Статусы обновляются
        автоматически.
      </Typography>
      {journal.error && <Alert severity="error">Не удалось обновить журнал: {journal.error}</Alert>}
      {!visible.length && <Typography color="text.secondary">{journal.loading ? 'Читаем журнал…' : 'Заданий пока нет.'}</Typography>}
      {visible.map((entry) => (
        <Paper
          key={`${entry.type}-${entry.job.id}`}
          id={`job-${entry.job.id}`}
          variant="outlined"
          sx={{ p: 2, scrollMarginTop: 70, borderColor: entry.job.id === selectedId ? 'primary.main' : 'divider' }}
        >
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Chip size="small" variant="outlined" label={entry.type === 'agent' ? 'Агент' : 'Инструмент'} />
              <Typography variant="caption" color="text.secondary" title={entry.job.project ?? undefined} sx={{ overflowWrap: 'anywhere' }}>
                {entry.job.project ? projectName(entry.job.project) : 'Общее задание приложения'}
              </Typography>
            </Box>
            {entry.type === 'agent' ? <AgentJobCard job={entry.job} onCancel={journal.cancel} onRetry={setRetry} /> : <JobCard job={entry.job} />}
          </Stack>
        </Paper>
      ))}
      {retry && <AgentRetryDialog key={retry.id} job={retry} onClose={() => setRetry(null)} />}
    </Stack>
  );
}
