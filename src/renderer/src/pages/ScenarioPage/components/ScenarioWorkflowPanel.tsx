import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { DestructiveButton } from '../../../components/DestructiveButton';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import type { ScenarioPass } from '@shared/scenario-workflow';
import { AgentButton } from '../../../components/AgentButton';
import { AiProblemAlert } from '../../../components/AiProblemAlert';
import { AgentJobCard } from '../../../components/AgentJobCard';
import type { useScenarioWorkflow } from '../useScenarioWorkflow';
import { ScenarioDraftConflictDialog } from './ScenarioDraftConflictDialog';
import { ScenarioReviseDialog } from './ScenarioReviseDialog';
import { ScenarioProposalDialog } from './ScenarioProposalDialog';
import { LinkedText } from '../../../components/LinkedText';

/** Доменные действия создают новое предложение; повтор всегда заново собирает контекст. */
export function ScenarioWorkflowPanel({
  project,
  workflow,
  selected,
  treatmentDirty,
  scenesDirty,
  editorBusy,
  scenesInputProblem,
  onResolveDrafts
}: {
  project: string;
  workflow: ReturnType<typeof useScenarioWorkflow>;
  selected: string | null;
  treatmentDirty: boolean;
  scenesDirty: boolean;
  editorBusy: boolean;
  /** Чего не хватает для подробного сценария: разметки или кастинга с изображениями. */
  scenesInputProblem?: string | null;
  onResolveDrafts(action: 'save' | 'discard'): Promise<boolean>;
}): ReactElement {
  const [preview, setPreview] = useState(false);
  const [revise, setRevise] = useState(false);
  const [reviseIds, setReviseIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => Promise<unknown>) | null>(null);
  const [resolving, setResolving] = useState(false);
  const activeProject = useRef<string | null>(project);
  useEffect(() => {
    activeProject.current = project;
    return () => {
      activeProject.current = null;
    };
  }, [project]);
  const { view, error, busy } = workflow;
  const disabled = busy || editorBusy || resolving;
  // Причина блокировки агентских кнопок видна в их подсказке.
  const busyReason = disabled
    ? commonTexts.operationPending
    : view?.busy
      ? scenarioTexts.workflow.agentBusy
      : view?.proposal && view.proposal.status === 'ready'
        ? scenarioTexts.workflow.resolveProposal
        : null;
  // Причина для обычных кнопок панели: их блокирует только выполняемая операция.
  const operationReason = disabled ? commonTexts.operationPending : null;
  const guard = (action: () => Promise<unknown>): void => {
    if (treatmentDirty || scenesDirty) setPendingAction(() => action);
    else void action();
  };
  const begin = (pass: ScenarioPass, ids?: string[]): void => {
    if (pass === 'revise') {
      setReviseIds(ids?.length ? ids : selected ? [selected] : []);
      setRevise(true);
    } else guard(() => workflow.start(pass));
  };
  const resolve = async (action: 'save' | 'discard'): Promise<void> => {
    setResolving(true);
    try {
      // Ожидавшее сохранения действие старой папки не продолжается после переключения проекта.
      if ((await onResolveDrafts(action)) && activeProject.current === project) {
        const continuation = pendingAction;
        setPendingAction(null);
        await continuation?.();
      }
    } finally {
      if (activeProject.current === project) setResolving(false);
    }
  };
  const proposal = view?.proposal;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">{scenarioTexts.workflow.title}</Typography>
          {view && (
            <Chip
              size="small"
              color={view.treatmentApproved ? 'success' : 'default'}
              label={view.treatmentApproved ? scenarioTexts.workflow.treatmentApproved : scenarioTexts.workflow.treatmentUnapproved}
            />
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.workflow.description}
        </Typography>
        <AiProblemAlert kinds={['agent']} />
        {view?.problems.length ? <ProblemList problems={view.problems} /> : null}
        {view?.scenesNeedReview && <Alert severity="warning">{scenarioTexts.workflow.scenesNeedReview}</Alert>}
        {view?.job && (
          <AgentJobCard
            compact
            job={view.job}
            onCancel={workflow.cancel}
            onRetry={() => {
              if (proposal && !disabled) begin(proposal.pass, proposal.selectedIds);
            }}
          />
        )}
        {/* Итог задания и применения дублируется в Snackbar (useScenarioWorkflow); здесь — состояние текущего предложения рядом с его действиями. */}
        {proposal && (
          <Stack spacing={1}>
            {proposal.status === 'applied' ? (
              <Alert severity="success">{proposal.message || scenarioTexts.workflow.proposalAppliedSentence}</Alert>
            ) : (
              proposal.message && <Alert severity={proposal.status === 'ready' || proposal.status === 'running' ? 'info' : 'warning'}>{proposal.message}</Alert>
            )}
            {proposal.stale && proposal.status !== 'applied' && <Alert severity="warning">{scenarioTexts.workflow.proposalStale}</Alert>}
            {proposal.status !== 'applied' && proposal.status !== 'running' && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {proposal.status === 'ready' && (
                  <ActionButton
                    variant="outlined"
                    startIcon={<CompareArrowsIcon />}
                    disabled={disabled}
                    disabledReason={operationReason}
                    onClick={() => setPreview(true)}
                  >
                    {scenarioTexts.workflow.reviewProposal}
                  </ActionButton>
                )}
                {(proposal.stale || proposal.status !== 'ready') && (
                  <AgentButton
                    variant="outlined"
                    disabled={disabled}
                    disabledReason={operationReason}
                    onClick={() => begin(proposal.pass, proposal.selectedIds)}
                  >
                    {scenarioTexts.workflow.newProposal}
                  </AgentButton>
                )}
                {proposal.status !== 'ready' && (
                  <DestructiveButton
                    label={scenarioTexts.proposal.discard}
                    description={scenarioTexts.proposal.discardDescription}
                    confirmLabel={scenarioTexts.proposal.discardConfirm}
                    variant="outlined"
                    size="medium"
                    disabled={disabled}
                    disabledReason={operationReason}
                    onConfirm={() => void workflow.discard()}
                  />
                )}
              </Stack>
            )}
          </Stack>
        )}
        {/* Ошибка запуска, утверждения или обновления показывается прямо над кнопками, которые её вызвали. */}
        {error && (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        )}
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <AgentButton
              variant="outlined"
              disabled={disabled || !view?.canStartTreatment}
              disabledReason={busyReason ?? view?.problems[0] ?? null}
              onClick={() => begin('treatment')}
            >
              {scenarioTexts.workflow.createTreatment}
            </AgentButton>
            <AgentButton
              variant="outlined"
              disabled={disabled || !view?.canStartScenes || !!scenesInputProblem}
              disabledReason={busyReason ?? (view?.canStartScenes ? scenesInputProblem : scenarioTexts.workflow.approveTreatmentHint)}
              onClick={() => begin('scenes')}
            >
              {scenarioTexts.workflow.createScenes}
            </AgentButton>
            <AgentButton
              variant="outlined"
              disabled={disabled || !view?.canRevise || !selected}
              disabledReason={
                busyReason ??
                (!view?.treatmentApproved
                  ? scenarioTexts.workflow.approveTreatmentReason
                  : !selected
                    ? scenarioTexts.workflow.selectShot
                    : scenarioTexts.workflow.fixRegistry)
              }
              onClick={() => begin('revise')}
            >
              {scenarioTexts.revise.title}
            </AgentButton>
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {view?.canApproveCurrent && (
              <ActionButton startIcon={<CheckCircleIcon />} disabled={disabled} disabledReason={operationReason} onClick={() => guard(workflow.approve)}>
                {scenarioTexts.workflow.approveTreatment}
              </ActionButton>
            )}
            {view?.canApproveScenes && (
              <ActionButton startIcon={<CheckCircleIcon />} disabled={disabled} disabledReason={operationReason} onClick={() => guard(workflow.approveScenes)}>
                {scenarioTexts.workflow.approveScenes}
              </ActionButton>
            )}
            <ActionButton startIcon={<RefreshIcon />} disabled={disabled} disabledReason={operationReason} onClick={() => guard(workflow.refresh)}>
              {scenarioTexts.workflow.refreshStatus}
            </ActionButton>
          </Stack>
        </Stack>
        <ScenarioDraftConflictDialog
          open={!!pendingAction}
          treatmentDirty={treatmentDirty}
          scenesDirty={scenesDirty}
          busy={resolving || editorBusy}
          onResolve={(action) => void resolve(action)}
          onClose={() => setPendingAction(null)}
        />
        <ScenarioReviseDialog
          open={revise}
          ids={reviseIds}
          note={note}
          busy={disabled}
          onNote={setNote}
          onClose={() => setRevise(false)}
          onStart={() => {
            if (!note.trim() || !reviseIds.length) return;
            setRevise(false);
            guard(() => workflow.start('revise', note.trim(), reviseIds));
          }}
        />
        {proposal && preview && (
          <ScenarioProposalDialog
            project={project}
            proposal={proposal}
            provider={view?.job?.provider ?? null}
            open
            busy={busy || editorBusy || resolving}
            error={error}
            onClose={() => setPreview(false)}
            onApply={() =>
              guard(async () => {
                if (await workflow.apply()) setPreview(false);
              })
            }
            onDiscard={() =>
              guard(async () => {
                if (await workflow.discard()) setPreview(false);
              })
            }
          />
        )}
      </Stack>
    </Paper>
  );
}

/** Длинный перечень (например, по каждому из 59 планов) не должен занимать весь экран: показываем начало и раскрываем по запросу. */
function ProblemList({ problems }: { problems: string[] }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? problems : problems.slice(0, 3);
  return (
    <Alert
      severity="warning"
      action={
        problems.length > 3 ? (
          <Button color="inherit" size="small" onClick={() => setExpanded((value) => !value)}>
            {expanded ? scenarioTexts.workflow.collapseProblems : scenarioTexts.workflow.showAllProblems({ count: problems.length })}
          </Button>
        ) : undefined
      }
    >
      <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2 }}>
        {shown.map((problem) => (
          <li key={problem}>
            <LinkedText text={problem} />
          </li>
        ))}
      </Stack>
    </Alert>
  );
}
