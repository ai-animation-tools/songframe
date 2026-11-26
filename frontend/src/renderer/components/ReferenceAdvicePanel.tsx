import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { castTexts } from '@shared/texts/cast';
import type { ReferenceAdviceItem, ReferenceAdviceView } from '@shared/scenario-workflow';
import { useReferenceAdvice } from '../hooks/useReferenceAdvice';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';
import { AgentJobCard } from './AgentJobCard';
import { LinkedText } from './LinkedText';

const texts = castTexts.advice;

/** Заметный статус совета в заголовке панели: результат шага виден без раскрытия. */
function StatusChip({ view }: { view: ReferenceAdviceView }): ReactElement {
  if (view.status === 'running') return <Chip size="small" color="info" label={texts.statusRunning} />;
  if (view.status === 'ready' && view.report) {
    return <Chip size="small" color={view.stale ? 'warning' : 'success'} label={texts.statusReady({ count: view.report.items.length })} />;
  }
  if (view.status === 'none') return <Chip size="small" variant="outlined" label={texts.statusNone} />;
  return <Chip size="small" color="warning" label={texts.statusFailed} />;
}

/** Пункт совета по одной сущности: что подготовить, сколько, ракурсы и состояния, почему и что уже есть. */
function AdviceItem({ item }: { item: ReferenceAdviceItem }): ReactElement {
  return (
    <Box sx={{ py: 1.5, borderTop: 1, borderColor: 'divider', minWidth: 0 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}>
        <Typography variant="subtitle2" component="h3">
          {item.name}
        </Typography>
        <Chip size="small" color="primary" variant="outlined" label={texts.count({ count: item.count })} />
        {!item.entity && <Chip size="small" color="warning" variant="outlined" label={texts.newEntity} />}
      </Stack>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {item.need}
      </Typography>
      {[
        { label: texts.views, values: item.views },
        { label: texts.states, values: item.states }
      ].map(({ label, values }) =>
        values.length ? (
          <Stack key={label} direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {label}:
            </Typography>
            {values.map((value) => (
              <Chip key={value} size="small" label={value} />
            ))}
          </Stack>
        ) : null
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
        {texts.why}: {item.why}
      </Typography>
      {item.have && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {texts.have}: {item.have}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Рекомендации агента по референсам проекта (свёрнутая панель): запуск задания только на чтение, итог по
 * сущностям и «Сохранить в файл». Одна запись совета общая для «Кастинга» и «Исходников»; без сценария
 * совет помечен «Предварительно».
 */
export function ReferenceAdvicePanel({ project, defaultExpanded = false }: { project: string; defaultExpanded?: boolean }): ReactElement {
  const advice = useReferenceAdvice(project);
  const view = advice.view;
  const running = view?.status === 'running';
  const report = view?.status === 'ready' ? view.report : null;
  const reason = advice.pending ? null : (view?.reason ?? null);
  return (
    <Accordion defaultExpanded={defaultExpanded} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <Typography variant="subtitle1" component="h2">
            {texts.title}
          </Typography>
          {view && <StatusChip view={view} />}
          {view?.preliminary && <Chip size="small" color="warning" variant="outlined" label={texts.preliminary} />}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          {view?.job && (running || view.status === 'failed') && (
            <AgentJobCard compact job={view.job} onCancel={advice.cancel} onRetry={() => !reason && void advice.start()} />
          )}
          <Typography variant="body2" color="text.secondary">
            {texts.description}
          </Typography>
          {view?.preliminary && <Alert severity="info">{texts.preliminaryHint}</Alert>}
          {view?.message && !running && <Alert severity={view.status === 'cancelled' ? 'info' : 'warning'}>{view.message}</Alert>}
          {view?.stale && report && <Alert severity="warning">{texts.stale}</Alert>}
          {report && (
            <Box>
              <Typography variant="body1" sx={{ mb: 1, overflowWrap: 'anywhere' }}>
                {report.summary}
              </Typography>
              {report.items.map((item, index) => (
                <AdviceItem key={`${index}-${item.entity}-${item.name}`} item={item} />
              ))}
            </Box>
          )}
          {advice.error && (
            <Alert severity="error">
              <LinkedText text={advice.error} />
            </Alert>
          )}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <AgentButton
              variant="outlined"
              disabled={!!reason || !view?.canStart || advice.pending}
              disabledReason={reason}
              onClick={() => void advice.start()}
            >
              {view && view.status !== 'none' ? texts.restart : texts.start}
            </AgentButton>
            {report && (
              <ActionButton variant="outlined" startIcon={<SaveAltIcon />} onClick={() => void advice.save()}>
                {texts.save}
              </ActionButton>
            )}
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
