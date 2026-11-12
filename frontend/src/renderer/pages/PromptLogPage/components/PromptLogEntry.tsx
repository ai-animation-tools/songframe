/**
 * Одна отправка журнала: строка с итогом, видом, исполнителем и временем; раскрытие читает полную
 * запись (promptLog.get) и показывает промпт, контекст или параметры, вложения, ответ и причину
 * сбоя, с переходом к месту в проекте. Только чтение: повторной отправки здесь нет.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { agentTitle, isAgentProvider } from '@shared/agent-providers';
import { mediaProviderInfo } from '@shared/media-providers';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { productionTexts } from '@shared/texts/production';
import { promptLogTexts as texts } from '@shared/texts/prompt-log';
import type { PromptLogPlace, PromptLogRecord, PromptLogStatus, PromptLogSummary } from '@shared/types';
import { formatDateTime } from '../../../format';
import { useApp } from '../../../state';

/** Цвет итога: заметный чип, а не серая подпись. */
const STATUS_COLORS: Record<PromptLogStatus, 'default' | 'success' | 'error' | 'warning' | 'info'> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
  interrupted: 'warning'
};

/** Маршруты мест журнала; неизвестная страница — без перехода. */
const PLACE_ROUTES: Record<string, { to: string; label: string }> = {
  project: { to: '/project', label: navigationTexts.pages.project },
  cast: { to: '/project/cast', label: navigationTexts.pages.cast },
  scenario: { to: '/project/scenario', label: navigationTexts.pages.scenario },
  production: { to: '/project/production', label: navigationTexts.pages.production }
};

/** Исполнитель: агент по реестру агентов, сервис генерации по реестру провайдеров. */
export function executorTitle(entry: Pick<PromptLogSummary, 'kind' | 'executor'>): string {
  if (entry.kind === 'agent' || entry.kind === 'agent_images') return isAgentProvider(entry.executor) ? agentTitle(entry.executor) : entry.executor;
  return mediaProviderInfo(entry.executor, entry.kind)?.title ?? entry.executor;
}

/** Переход к месту отправки: страница и, у плана, выбранный план. */
function PlaceLink({ place }: { place: PromptLogPlace }): ReactElement | null {
  const route = PLACE_ROUTES[place.page];
  if (!route) return null;
  const to = place.shot ? `${route.to}?shot=${encodeURIComponent(place.shot)}` : route.to;
  return (
    <Button component={Link} to={to} size="small" variant="outlined" startIcon={<OpenInNewIcon />} sx={{ alignSelf: 'flex-start' }}>
      {place.shot ? texts.openShot({ page: route.label, shot: place.shot }) : texts.open({ page: route.label })}
    </Button>
  );
}

/** Текст записи как есть, моноширинно, с прокруткой и копированием. */
function RecordText({ title, text }: { title: string; text: string }): ReactElement {
  const { notify, describeError } = useApp();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      notify(commonTexts.copied, 'success');
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => void copy()}>
          {texts.copy}
        </Button>
      </Stack>
      <Box
        component="pre"
        // Прокручиваемая область получает фокус с клавиатуры и имя для чтения с экрана.
        role="region"
        tabIndex={0}
        aria-label={title}
        sx={{
          m: 0,
          maxHeight: 320,
          overflow: 'auto',
          bgcolor: 'action.hover',
          p: 1.5,
          borderRadius: 1,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontSize: 13
        }}
      >
        {text}
      </Box>
    </Box>
  );
}

/** Полная запись: читается при первом раскрытии и перечитывается, пока отправка выполняется. */
function RecordDetails({ project, entry }: { project: string; entry: PromptLogSummary }): ReactElement {
  const { describeError } = useApp();
  const [record, setRecord] = useState<PromptLogRecord | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    window.api.promptLog
      .get(project, entry.id)
      .then((next) => {
        if (active) setRecord(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(describeError(reason));
      });
    return () => {
      active = false;
    };
  }, [project, entry.id, entry.status, describeError]);

  if (error) return <Alert severity="error">{texts.loadFailed({ reason: error })}</Alert>;
  if (record === undefined)
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={14} aria-hidden />
        <Typography variant="body2">{texts.loading}</Typography>
      </Stack>
    );
  if (record === null) return <Alert severity="warning">{texts.missing}</Alert>;
  const paid = record.paid;
  return (
    <Stack spacing={2}>
      {record.place ? <PlaceLink place={record.place} /> : null}
      {record.error ? (
        <Alert severity={record.status === 'cancelled' || record.status === 'interrupted' ? 'warning' : 'error'}>
          {texts.error}: {record.error}
        </Alert>
      ) : null}
      {record.truncated ? <Alert severity="info">{texts.truncated}</Alert> : null}
      {paid ? (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          {paid.generation_id ? <Chip size="small" label={texts.generation({ id: paid.generation_id })} /> : null}
          {paid.amount !== null ? (
            <Chip size="small" color="primary" label={texts.amount({ text: productionTexts.shotSpend.amount({ amount: paid.amount, unit: paid.unit }) })} />
          ) : null}
        </Stack>
      ) : null}
      <RecordText title={texts.prompt} text={record.prompt} />
      {record.context ? <RecordText title={paid ? texts.parameters : texts.context} text={record.context} /> : null}
      {record.attachments.length ? (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            {texts.attachments}
          </Typography>
          <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {record.attachments.map((item) => (
              <Typography component="li" variant="body2" key={`${item.path}:${item.sha256}`} sx={{ overflowWrap: 'anywhere' }}>
                {item.path}
                {item.sha256 ? (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {' '}
                    · SHA-256 {item.sha256.slice(0, 12)}
                  </Typography>
                ) : null}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
      {record.response ? <RecordText title={texts.response} text={record.response} /> : <Typography color="text.secondary">{texts.noResponse}</Typography>}
    </Stack>
  );
}

export function PromptLogEntry({ project, entry }: { project: string; entry: PromptLogSummary }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const finished = entry.finishedAt ? `, ${texts.finished({ at: formatDateTime(entry.finishedAt) })}` : '';
  return (
    <Accordion
      expanded={expanded}
      onChange={(_, next) => setExpanded(next)}
      disableGutters
      variant="outlined"
      slotProps={{ transition: { unmountOnExit: true } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip size="small" color={STATUS_COLORS[entry.status]} label={texts.statuses[entry.status]} />
            <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{texts.title(entry.title)}</Typography>
            {entry.paid ? <Chip size="small" variant="outlined" color="warning" label={texts.paid} /> : null}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {texts.kinds[entry.kind]} · {executorTitle(entry)}
            {entry.model ? ` · ${texts.model({ model: entry.model })}` : ''} · {texts.started({ at: formatDateTime(entry.startedAt) })}
            {finished}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <RecordDetails project={project} entry={entry} />
      </AccordionDetails>
    </Accordion>
  );
}
