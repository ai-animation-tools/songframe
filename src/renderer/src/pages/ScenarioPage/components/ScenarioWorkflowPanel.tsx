import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { DestructiveButton } from '../../../components/DestructiveButton';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import type { ScenarioPass } from '@shared/scenario-workflow';
import { AgentButton } from '../../../components/AgentButton';
import { AgentJobCard } from '../../../components/AgentJobCard';
import type { useScenarioWorkflow } from '../useScenarioWorkflow';
import { ScenarioDraftConflictDialog } from './ScenarioDraftConflictDialog';
import { ScenarioReviseDialog } from './ScenarioReviseDialog';
import { ScenarioProposalDialog } from './ScenarioProposalDialog';

/** Доменные действия создают новое предложение; повтор всегда заново собирает контекст. */
export function ScenarioWorkflowPanel({
  project,
  workflow,
  selected,
  treatmentDirty,
  scenesDirty,
  editorBusy,
  onResolveDrafts
}: {
  project: string;
  workflow: ReturnType<typeof useScenarioWorkflow>;
  selected: string | null;
  treatmentDirty: boolean;
  scenesDirty: boolean;
  editorBusy: boolean;
  onResolveDrafts(action: 'save' | 'discard'): Promise<boolean>;
}): ReactElement {
  const { aiAccess } = useApp();
  const aiProblem = aiActionProblem(aiAccess);
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
          <Typography variant="h6">Подготовка с агентом</Typography>
          {view && (
            <Chip
              size="small"
              color={view.treatmentApproved ? 'success' : 'default'}
              label={view.treatmentApproved ? 'Кастинг и трактовка утверждены' : 'Кастинг и трактовка не утверждены'}
            />
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Агент готовит предложение. Сначала просмотрите сравнение, затем отдельно примените результат. Ручные редакторы доступны без CLI.
        </Typography>
        {aiProblem && <Alert severity="info">{aiProblem}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        {view?.problems.map((problem) => (
          <Alert key={problem} severity="warning">
            {problem}
          </Alert>
        ))}
        {view?.scenesNeedReview && <Alert severity="warning">Кастинг или трактовка изменились. Существующий сценарий требует пересмотра.</Alert>}
        {view && !view.treatmentApproved && (
          <Typography variant="caption">
            Для подробного сценария требуется актуальное утверждение кастинга и трактовки. Готовую ручную пару можно утвердить без повторной генерации.
          </Typography>
        )}
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
        {proposal && (
          <Stack spacing={1}>
            {proposal.message && (
              <Alert severity={proposal.status === 'ready' ? 'info' : proposal.status === 'applied' ? 'success' : 'warning'}>{proposal.message}</Alert>
            )}
            {proposal.stale && <Alert severity="warning">Предложение устарело. Исходные файлы изменились; нужен новый запуск.</Alert>}
            {proposal.status === 'ready' && (
              <Stack direction="row" spacing={1}>
                <Button startIcon={<CompareArrowsIcon />} variant="contained" disabled={disabled} onClick={() => setPreview(true)}>
                  Просмотреть предложение и сравнение
                </Button>
                <DestructiveButton
                  label="Отбросить предложение"
                  description="Предложение будет отброшено без записи в проект."
                  confirmLabel="Отбросить"
                  disabled={disabled}
                  onConfirm={() => void workflow.discard()}
                />
                {proposal.stale && (
                  <AgentButton color="success" disabled={disabled} onClick={() => begin(proposal.pass, proposal.selectedIds)}>
                    Создать новое предложение
                  </AgentButton>
                )}
              </Stack>
            )}
            {['invalid', 'failed', 'interrupted'].includes(proposal.status) && (
              <Stack direction="row" spacing={1}>
                <AgentButton color="success" disabled={disabled} onClick={() => begin(proposal.pass, proposal.selectedIds)}>
                  Создать новое предложение
                </AgentButton>
                <DestructiveButton
                  label="Отбросить предложение"
                  description="Предложение будет отброшено без записи в проект."
                  confirmLabel="Отбросить"
                  disabled={disabled}
                  onConfirm={() => void workflow.discard()}
                />
              </Stack>
            )}
            {proposal.status === 'applied' && <Alert severity="success">Предложение применено.</Alert>}
          </Stack>
        )}
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <AgentButton color="success" variant="outlined" disabled={disabled || !view?.canStartTreatment} onClick={() => begin('treatment')}>
            Создать трактовку
          </AgentButton>
          <AgentButton color="success" variant="outlined" disabled={disabled || !view?.canStartScenes} onClick={() => begin('scenes')}>
            Создать сценарий
          </AgentButton>
          <AgentButton disabled={disabled || !view?.canRevise || !selected} onClick={() => begin('revise')}>
            Доработать выбранный план
          </AgentButton>
          {view?.canApproveCurrent && (
            <Button startIcon={<CheckCircleIcon />} disabled={disabled} onClick={() => guard(workflow.approve)}>
              Утвердить текущие кастинг и трактовку
            </Button>
          )}
          {view?.canApproveScenes && (
            <Button startIcon={<CheckCircleIcon />} disabled={disabled} onClick={() => guard(workflow.approveScenes)}>
              Утвердить текущий сценарий
            </Button>
          )}
        </Stack>
        <Button startIcon={<RefreshIcon />} size="small" disabled={disabled} onClick={() => guard(workflow.refresh)}>
          Обновить статус
        </Button>
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
          />
        )}
      </Stack>
    </Paper>
  );
}
