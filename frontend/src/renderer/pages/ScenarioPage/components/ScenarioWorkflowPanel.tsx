import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { DestructiveButton } from '../../../components/DestructiveButton';
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
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

/** Доменные действия создают новое предложение; повтор всегда заново собирает контекст. */
export function ScenarioWorkflowPanel({
  project,
  workflow,
  selected,
  hasShots,
  scenesDirty,
  editorBusy,
  scenesInputProblem,
  reviseRequest = null,
  onResolveDrafts
}: {
  project: string;
  workflow: ReturnType<typeof useScenarioWorkflow>;
  selected: string | null;
  /** В сценарии есть планы: только тогда выбирается план, который дорабатывает агент. */
  hasShots: boolean;
  scenesDirty: boolean;
  editorBusy: boolean;
  /** Чего не хватает для подробного сценария: разметки или кастинга с изображениями. */
  scenesInputProblem?: string | null;
  /** Доработка, открытая из отчёта проверки: планы, замечание и номер проблемы; seq различает повторные запросы. */
  reviseRequest?: { ids: string[]; note: string; issue: number; seq: number } | null;
  onResolveDrafts(action: 'save' | 'discard'): Promise<boolean>;
}): ReactElement {
  const [preview, setPreview] = useState(false);
  const [revise, setRevise] = useState(false);
  const [reviseIds, setReviseIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  // Проблема отчёта, из которой открыта доработка: применённое предложение отметит её исправленной.
  const [reviseIssue, setReviseIssue] = useState<number | undefined>(undefined);
  const [pendingAction, setPendingAction] = useState<(() => Promise<unknown>) | null>(null);
  // Части и сценарий запускаются только после подтверждения: окно называет, что сделает агент, а при принятых
  // планах — и последствия для них.
  const [confirmPass, setConfirmPass] = useState<'treatment' | 'scenes' | null>(null);
  // Предложение сверяется с хешами сохранённых документов: запись правок перед применением сделала бы его устаревшим.
  const [saveBlocked, setSaveBlocked] = useState(false);
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
  const guard = (action: () => Promise<unknown>, blockSave = false): void => {
    if (!scenesDirty) {
      void action();
      return;
    }
    setSaveBlocked(blockSave);
    setPendingAction(() => action);
  };
  const acceptedShots = view?.acceptedShots ?? [];
  /**
   * Запуск прохода. Доработка открывает своё окно с замечанием. Части и сценарий спрашивают подтверждение; повтор
   * сбоя (confirm = false) — только при принятых планах, ради предупреждения о них.
   */
  const begin = (pass: ScenarioPass, ids?: string[], confirm = true): void => {
    if (pass === 'revise') {
      setReviseIssue(undefined);
      setReviseIds(ids?.length ? ids : selected ? [selected] : []);
      setRevise(true);
    } else if (confirm || acceptedShots.length) setConfirmPass(pass);
    else guard(() => workflow.start(pass));
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
  // Запрос из отчёта проверки открывает то же окно доработки с планами проблемы и её описанием.
  useEffect(() => {
    if (!reviseRequest) return;
    setReviseIds(reviseRequest.ids);
    setNote(reviseRequest.note);
    setReviseIssue(reviseRequest.issue);
    setRevise(true);
  }, [reviseRequest]);
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
        {view?.scenesNeedReview && (
          <Alert severity="warning">
            <LinkedText
              text={scenarioTexts.workflow.scenesNeedReview(view.changedInputs, view.canApproveScenes ? 'scenes' : view.canApproveCurrent ? 'pair' : null)}
            />
          </Alert>
        )}
        {view?.job && (
          <AgentJobCard
            compact
            job={view.job}
            onCancel={workflow.cancel}
            onRetry={() => {
              if (proposal && !disabled) begin(proposal.pass, proposal.selectedIds, false);
            }}
          />
        )}
        {/* Итог задания и применения дублируется в Snackbar (useScenarioWorkflow); здесь — состояние текущего предложения рядом с его действиями. */}
        {proposal && (
          <Stack spacing={1}>
            {proposal.status === 'applied' ? (
              <Alert severity="success">{proposal.message || scenarioTexts.workflow.proposalAppliedSentence}</Alert>
            ) : (
              proposal.message && <Alert severity={['ready', 'running', 'cancelled'].includes(proposal.status) ? 'info' : 'warning'}>{proposal.message}</Alert>
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
            {hasShots && (
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
            )}
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
          </Stack>
        </Stack>
        <ScenarioDraftConflictDialog
          open={!!pendingAction}
          busy={resolving || editorBusy}
          saveBlockedReason={saveBlocked ? scenarioTexts.drafts.applyNeedsSaved : undefined}
          onResolve={(action) => void resolve(action)}
          onClose={() => setPendingAction(null)}
        />
        <ConfirmationDialog
          open={!!confirmPass}
          title={confirmPass ? scenarioTexts.workflow.confirmTitle[confirmPass] : ''}
          description={confirmPass ? scenarioTexts.workflow.confirmDescription[confirmPass] : undefined}
          confirmLabel={confirmPass === 'scenes' ? scenarioTexts.workflow.createScenes : scenarioTexts.workflow.createTreatment}
          confirmAgent={{}}
          confirmColor={acceptedShots.length ? 'warning' : 'primary'}
          cancelAutoFocus
          onClose={() => setConfirmPass(null)}
          onConfirm={() => {
            const pass = confirmPass;
            setConfirmPass(null);
            if (pass) guard(() => workflow.start(pass));
          }}
        >
          {confirmPass && acceptedShots.length ? (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {scenarioTexts.accepted[confirmPass]({ shots: acceptedShots })} {scenarioTexts.accepted.kept}
            </Alert>
          ) : null}
        </ConfirmationDialog>
        <ScenarioReviseDialog
          open={revise}
          ids={reviseIds}
          acceptedIds={reviseIds.filter((id) => acceptedShots.includes(id))}
          note={note}
          busy={disabled}
          onNote={setNote}
          onClose={() => setRevise(false)}
          onStart={() => {
            const text = note.trim();
            if (!text || !reviseIds.length) return;
            setRevise(false);
            const issue = reviseIssue;
            setReviseIssue(undefined);
            // Запущенное замечание не остаётся в поле: иначе следующее открытие окна сразу разрешило бы
            // повторную доработку тем же текстом. Отмена окна, напротив, сохраняет текст как черновик.
            setNote('');
            guard(() => workflow.start('revise', text, reviseIds, issue));
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
              }, true)
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
