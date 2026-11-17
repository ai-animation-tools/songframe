import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import type { ScenarioCheckIssue, ScenarioCheckSeverity, ScenarioCheckView } from '@shared/scenario-workflow';
import { AgentButton } from '../../../components/AgentButton';
import { AgentJobCard } from '../../../components/AgentJobCard';
import { ActionButton } from '../../../components/ActionButton';
import { LinkedText } from '../../../components/LinkedText';
import { ScenarioDraftConflictDialog } from './ScenarioDraftConflictDialog';
import type { useScenarioCheck } from '../useScenarioCheck';

/** Сколько проблем видно до «Показать все»: отчёт не должен отодвигать редактор на несколько экранов. */
const SHOWN_ISSUES = 5;

const SEVERITY_ORDER: ScenarioCheckSeverity[] = ['high', 'medium', 'low'];
const SEVERITY_COLOR = { high: 'error', medium: 'warning', low: 'default' } as const;

/**
 * Блок «Проверка сценария»: статус последней проверки, задание агента, итог и проблемы с переходом к
 * плану. Проверяется сохранённый сценарий, поэтому запуск при несохранённых правках сначала
 * предлагает сохранить или отменить их — тем же диалогом, что и проходы агента.
 */
export function ScenarioCheckPanel({
  check,
  blockedReason,
  treatmentDirty,
  scenesDirty,
  editorBusy,
  entityName,
  onOpenShot,
  onResolveDrafts
}: {
  check: ReturnType<typeof useScenarioCheck>;
  /** Причина, по которой страница сейчас не даёт запускать агента (идёт операция или проход). */
  blockedReason: string | null;
  treatmentDirty: boolean;
  scenesDirty: boolean;
  editorBusy: boolean;
  entityName(id: string): string;
  /** Переход к плану проблемы: проблемы состояния открывают блок состояния первого кадра. */
  onOpenShot(shot: string, issue: ScenarioCheckIssue): void;
  onResolveDrafts(action: 'save' | 'discard'): Promise<boolean>;
}): ReactElement {
  const [confirmDrafts, setConfirmDrafts] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { view, error, pending } = check;
  const running = view?.status === 'running';
  const reason = pending || resolving ? commonTexts.operationPending : (blockedReason ?? view?.reason ?? null);
  const start = (): void => {
    if (treatmentDirty || scenesDirty) setConfirmDrafts(true);
    else void check.start();
  };
  const resolve = async (action: 'save' | 'discard'): Promise<void> => {
    setResolving(true);
    try {
      if (await onResolveDrafts(action)) {
        setConfirmDrafts(false);
        await check.start();
      }
    } finally {
      setResolving(false);
    }
  };
  const issues = [...(view?.report?.issues ?? [])].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const shown = expanded ? issues : issues.slice(0, SHOWN_ISSUES);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">{scenarioTexts.check.title}</Typography>
          {view && <StatusChip view={view} />}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.check.description}
        </Typography>
        {view?.job && (running || view.status === 'failed') && (
          <AgentJobCard compact job={view.job} onCancel={check.cancel} onRetry={() => !reason && start()} />
        )}
        {view?.message && !running && <Alert severity={view.status === 'cancelled' ? 'info' : 'warning'}>{view.message}</Alert>}
        {view?.stale && view.report && <Alert severity="warning">{scenarioTexts.check.stale}</Alert>}
        {view?.report && (
          <Stack spacing={1}>
            <Typography variant="body1">{view.report.summary}</Typography>
            {!issues.length && <Alert severity="success">{scenarioTexts.check.clean}</Alert>}
            <Box>
              {shown.map((issue, index) => (
                <IssueItem key={`${index}-${issue.title}`} issue={issue} entityName={entityName} onOpenShot={onOpenShot} />
              ))}
            </Box>
            {issues.length > SHOWN_ISSUES && (
              <Box>
                <Button size="small" onClick={() => setExpanded((value) => !value)}>
                  {expanded ? scenarioTexts.check.collapse : scenarioTexts.check.showAll({ count: issues.length })}
                </Button>
              </Box>
            )}
          </Stack>
        )}
        {error && (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        )}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <AgentButton variant="outlined" disabled={!!reason || !view?.canStart} disabledReason={reason} onClick={start}>
            {view && view.status !== 'none' ? scenarioTexts.check.restart : scenarioTexts.check.start}
          </AgentButton>
        </Stack>
      </Stack>
      <ScenarioDraftConflictDialog
        open={confirmDrafts}
        treatmentDirty={treatmentDirty}
        scenesDirty={scenesDirty}
        busy={resolving || editorBusy}
        onResolve={(action) => void resolve(action)}
        onClose={() => setConfirmDrafts(false)}
      />
    </Paper>
  );
}

/** Заметный статус последней проверки: устаревший отчёт важнее числа проблем. */
function StatusChip({ view }: { view: ScenarioCheckView }): ReactElement {
  const count = view.report?.issues.length ?? 0;
  const high = view.report?.issues.some((issue) => issue.severity === 'high');
  const [label, color] =
    view.status === 'none'
      ? [scenarioTexts.check.statusNone, 'default' as const]
      : view.status === 'running'
        ? [scenarioTexts.check.statusRunning, 'info' as const]
        : view.status !== 'ready'
          ? [scenarioTexts.check.statusFailed, 'warning' as const]
          : view.stale
            ? [scenarioTexts.check.statusStale, 'warning' as const]
            : count
              ? [scenarioTexts.check.statusIssues({ count }), high ? ('error' as const) : ('warning' as const)]
              : [scenarioTexts.check.statusClean, 'success' as const];
  return <Chip size="small" color={color} label={label} />;
}

/** Проблема отчёта: в заголовке — важность, группа, суть и планы; раскрытие — объяснение и переходы к планам. */
function IssueItem({
  issue,
  entityName,
  onOpenShot
}: {
  issue: ScenarioCheckIssue;
  entityName(id: string): string;
  onOpenShot(shot: string, issue: ScenarioCheckIssue): void;
}): ReactElement {
  return (
    <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <Chip size="small" color={SEVERITY_COLOR[issue.severity]} label={scenarioTexts.check.severities[issue.severity]} />
          <Typography variant="body2" color="text.secondary">
            {scenarioTexts.check.groups[issue.group]}
          </Typography>
          <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
            {issue.title}
          </Typography>
          {issue.shots.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {issue.shots.join(', ')}
            </Typography>
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <IssueText label={scenarioTexts.check.problem} text={issue.problem} />
          <IssueText label={scenarioTexts.check.why} text={issue.why} />
          <IssueText label={scenarioTexts.check.fix} text={issue.fix} />
          {issue.entities.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {scenarioTexts.check.entities({ names: issue.entities.map(entityName).join(', ') })}
            </Typography>
          )}
          {issue.shots.length > 0 && (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {issue.shots.map((shot) => (
                <ActionButton
                  key={shot}
                  size="small"
                  variant="outlined"
                  startIcon={<ArrowForwardIcon />}
                  title={scenarioTexts.check.openShotHint({ shot })}
                  onClick={() => onOpenShot(shot, issue)}
                >
                  {scenarioTexts.check.openShot({ shot })}
                </ActionButton>
              ))}
            </Stack>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

function IssueText({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <Box>
      <Typography variant="subtitle2" component="div">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {text}
      </Typography>
    </Box>
  );
}
