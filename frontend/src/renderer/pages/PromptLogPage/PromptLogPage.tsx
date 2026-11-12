/**
 * «Отправки»: что приложение отправило агенту и сервисам генерации в этом проекте и что получило
 * в ответ, включая ошибки, остановленные и прерванные отправки. Журнал plan/prompt-log ведёт Go;
 * страница только читает его, фильтрует по виду и итогу и ведёт к месту в проекте.
 */
import { useState, type ReactElement } from 'react';
import { Alert, Box, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import { promptLogTexts as texts } from '@shared/texts/prompt-log';
import type { PromptLogKind, PromptLogStatus } from '@shared/types';
import { PageActionBar } from '../../components/PageActionBar';
import { usePageLoading } from '../../components/PageLoader';
import { useApp } from '../../state';
import { PromptLogEntry } from './components/PromptLogEntry';
import { usePromptLog } from './usePromptLog';

const KINDS = Object.keys(texts.kinds) as PromptLogKind[];
const STATUSES = Object.keys(texts.statuses) as PromptLogStatus[];

export function PromptLogPage(): ReactElement {
  const { state } = useApp();
  const project = state?.current ?? '';
  const { entries, error } = usePromptLog(project);
  const [kind, setKind] = useState<PromptLogKind | 'all'>('all');
  const [status, setStatus] = useState<PromptLogStatus | 'all'>('all');
  usePageLoading(entries === null && !error);
  const all = entries ?? [];
  const visible = all.filter((entry) => (kind === 'all' || entry.kind === kind) && (status === 'all' || entry.status === status));
  const filtered = kind !== 'all' || status !== 'all';

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0, pb: 4 }}>
      <PageActionBar>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <Typography variant="h5" noWrap>
            {texts.heading}
          </Typography>
          {all.length ? <Chip size="small" label={texts.count({ shown: visible.length, total: all.length })} /> : null}
          <Box sx={{ flex: 1 }} />
          <TextField
            select
            size="small"
            label={texts.kindFilter}
            value={kind}
            onChange={(event) => setKind(event.target.value as PromptLogKind | 'all')}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="all">{texts.all}</MenuItem>
            {KINDS.map((value) => (
              <MenuItem key={value} value={value}>
                {texts.kinds[value]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label={texts.statusFilter}
            value={status}
            onChange={(event) => setStatus(event.target.value as PromptLogStatus | 'all')}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="all">{texts.all}</MenuItem>
            {STATUSES.map((value) => (
              <MenuItem key={value} value={value}>
                {texts.statuses[value]}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      </PageActionBar>
      {error ? <Alert severity="error">{texts.loadFailed({ reason: error })}</Alert> : null}
      {entries !== null && !visible.length ? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <Typography color="text.secondary">{filtered && all.length ? texts.emptyFiltered : texts.empty}</Typography>
            {filtered && all.length ? (
              <Button
                startIcon={<FilterAltOffIcon />}
                onClick={() => {
                  setKind('all');
                  setStatus('all');
                }}
              >
                {texts.resetFilters}
              </Button>
            ) : null}
          </Stack>
        </Paper>
      ) : null}
      {visible.length ? (
        <Box>
          {visible.map((entry) => (
            <PromptLogEntry key={entry.id} project={project} entry={entry} />
          ))}
        </Box>
      ) : null}
    </Stack>
  );
}
