/** Единая хронология сохраняет штатные карточки и операции двух разных API заданий. */
import { useEffect, useState, type ReactElement } from 'react';
import { ActionButton } from '../../components/ActionButton';
import { usePageLoading } from '../../components/PageLoader';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Chip, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { PageActionBar } from '../../components/PageActionBar';
import type { AgentJob } from '@shared/agents';
import type { JobInfo } from '@shared/types';
import { AgentJobCard } from '../../components/AgentJobCard';
import { AgentRetryDialog } from '../../components/AgentRetryDialog';
import { useApp } from '../../state';
import { ToolJobEntry } from './components';
import { useJobsJournal } from './useJobsJournal';

export function JobsPage(): ReactElement {
  const { state, notify, describeError } = useApp();
  const journal = useJobsJournal();
  // Пока журнал читается впервые, общий прелоадер оболочки показывает индикатор.
  usePageLoading(journal.loading && !journal.tools.length && !journal.agents.length);
  const [saving, setSaving] = useState(false);
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

  const copyJob = async (job: JobInfo): Promise<void> => {
    try {
      await navigator.clipboard.writeText(await window.api.jobs.copyText(job.id));
      notify(`Журнал задания «${job.title}» скопирован`, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const saveReport = async (): Promise<void> => {
    setSaving(true);
    try {
      const path = await window.api.diagnostics.saveReport();
      if (path) notify(`Отчёт сохранён: ${path}. Отправьте этот файл разработчику.`, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    // Прямой переход с рабочей страницы прокручивает хронологию к нужной записи.
    if (selectedId && selectedVisible) document.getElementById(`job-${selectedId}`)?.scrollIntoView({ block: 'center' });
  }, [selectedId, selectedVisible]);

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5">Журнал заданий</Typography>
        <Box sx={{ flex: 1 }} />
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
        <ActionButton
          startIcon={<BugReportOutlinedIcon />}
          disabled={saving}
          disabledReason="Отчёт уже сохраняется."
          onClick={() => void saveReport()}
          title="Один текстовый файл с версиями, журналом сбоев и последними заданиями, без настроек и данных входа"
        >
          Сохранить отчёт для разработчика
        </ActionButton>
      </PageActionBar>
      <Typography variant="body2" color="text.secondary">
        Инструменты и агенты в порядке запуска, новые сверху. Общие задания приложения видны вместе с заданиями выбранного проекта. Статусы обновляются
        автоматически. Журнал сохраняется между запусками: задания прошлых сеансов отмечены отдельно. Если программа завершилась сбоем, сохраните отчёт для
        разработчика и отправьте ему файл.
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
            {entry.type === 'agent' ? (
              <AgentJobCard job={entry.job} onCancel={journal.cancel} onRetry={setRetry} />
            ) : (
              <ToolJobEntry job={entry.job} onCopy={(job) => void copyJob(job)} />
            )}
          </Stack>
        </Paper>
      ))}
      {retry && <AgentRetryDialog key={retry.id} job={retry} onClose={() => setRetry(null)} />}
    </Stack>
  );
}
