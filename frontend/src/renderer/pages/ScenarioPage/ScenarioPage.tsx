import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { type ReactElement, useState } from 'react';
import { usePageLoading } from '../../components/PageLoader';
import { Alert, AlertTitle, Button, Paper, Stack, Typography } from '@mui/material';
import { ScenarioToolbar, ScenesSaveDialog, ScenarioPartsEditor, SceneRegistry } from './components';
import { useScenario } from './useScenario';
import { useScenarioWorkflow } from './useScenarioWorkflow';
import { useScenarioCheck } from './useScenarioCheck';
import { ScenarioCheckPanel, type CheckIssueFocus } from './components/ScenarioCheckPanel';
import { ActionButton } from '../../components/ActionButton';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { ScenarioWorkflowPanel } from './components/ScenarioWorkflowPanel';
import { PageActionBar } from '../../components/PageActionBar';
import { useStickyTop } from '../../hooks/useStickyTop';
import ReplayIcon from '@mui/icons-material/Replay';
import AddIcon from '@mui/icons-material/Add';
import TimelineIcon from '@mui/icons-material/Timeline';
import { LinkedText } from '../../components/LinkedText';
import { unsavedDraftsReason } from './shotNavigation';

/**
 * Страница сценария: один черновик plan/scenes.json — блок «Общие правила и части» над планами. Пока планов нет,
 * блок частей раскрыт, а на месте планов — подсказка о втором проходе агента.
 */
export function ScenarioPage(): ReactElement {
  const scenario = useScenario();
  const workflow = useScenarioWorkflow(scenario.project, scenario.acceptWorkflowUpdate);
  // Правки проверки записывают реестр: страница перечитывает его, как после применения прохода сцен.
  const check = useScenarioCheck(scenario.project, () => scenario.acceptWorkflowUpdate('scenes'));
  // Раскрытие блока частей: пока пользователь его не переключал, он раскрыт только у сценария без планов.
  const [partsOpen, setPartsOpen] = useState<boolean | null>(null);
  const [reviseRequest, setReviseRequest] = useState<{ ids: string[]; note: string; issue: number; seq: number } | null>(null);
  const [checkFocus, setCheckFocus] = useState<CheckIssueFocus | null>(null);
  const {
    view,
    loadError,
    retry,
    scenes,
    setScenes,
    selected,
    setSelected,
    revealShot,
    clearReveal,
    openShotState,
    problems,
    hasShots,
    brief,
    busy,
    cast,
    entityOptions,
    referenceOptions,
    propertiesOf,
    duration,
    scenesDirty,
    partsFromTiming,
    updatePart,
    saveScenes,
    saveRequest,
    confirmSaveScenes,
    cancelSaveScenes,
    keepUseless,
    notify
  } = scenario;

  // Отступ закреплённого списка планов: шапка, панель действий и зазор сетки.
  const { barRef, stickyTop } = useStickyTop([view]);
  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<ReplayIcon />} onClick={retry}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );
  if (!view) return <></>;

  // Нерешённые проблемы отчёта проверки у выбранного плана — плашкой над его карточкой.
  const shotIssues = selected
    ? (check.view?.report?.issues ?? [])
        .map((issue, index) => ({ issue, index }))
        .filter(({ issue }) => !issue.fixed && !issue.resolved && issue.shots.includes(selected))
    : [];
  const workflowView = workflow.view;
  const reviseReason = !workflowView
    ? commonTexts.operationPending
    : workflowView.canRevise
      ? null
      : !workflowView.treatmentApproved
        ? scenarioTexts.workflow.approveTreatmentReason
        : workflowView.proposal?.status === 'ready'
          ? scenarioTexts.workflow.resolveProposal
          : scenarioTexts.workflow.agentBusy;

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0, pb: 8 }}>
      <PageActionBar barRef={barRef}>
        <ScenarioToolbar
          scenes={scenes}
          busy={busy || workflow.busy}
          hasShots={hasShots}
          scenesDirty={scenesDirty}
          referencesStale={view.referencesStale}
          problems={problems}
          saveScenes={saveScenes}
          keepUseless={keepUseless}
          boundsProblem={scenario.boundsProblem}
          recalculateBounds={scenario.recalculateBounds}
        />
      </PageActionBar>
      <ScenesSaveDialog request={saveRequest} busy={busy} onConfirm={(keep) => void confirmSaveScenes(keep)} onClose={cancelSaveScenes} />
      {view.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {!cast ? <Alert severity="info">{scenarioTexts.page.castMissing}</Alert> : null}
      <ScenarioWorkflowPanel
        key={scenario.project}
        project={scenario.project}
        workflow={workflow}
        selected={selected}
        hasShots={hasShots}
        scenesDirty={scenesDirty}
        editorBusy={busy}
        scenesInputProblem={scenario.scenesInputProblem}
        reviseRequest={reviseRequest}
        onResolveDrafts={scenario.resolveWorkflowDrafts}
      />
      <ScenarioCheckPanel
        key={`check-${scenario.project}`}
        check={check}
        blockedReason={busy || workflow.pending ? commonTexts.operationPending : null}
        reviseReason={reviseReason}
        focus={checkFocus}
        onRevise={(ids, note, issue) => setReviseRequest((current) => ({ ids, note, issue, seq: (current?.seq ?? 0) + 1 }))}
        scenesDirty={scenesDirty}
        editorBusy={busy}
        entityName={(id) => cast?.entities.find((entity) => entity.id === id)?.name ?? id}
        onOpenShot={(shot, issue) =>
          issue.group === 'state'
            ? openShotState(
                shot,
                issue.entities.find((id) => id !== 'world'),
                'before'
              )
            : scenario.openShot(shot)
        }
        onResolveDrafts={scenario.resolveWorkflowDrafts}
      />
      {workflow.busy && (
        <Alert severity="warning">
          {/* Блокировка держится и пока готовое предложение ждёт решения, а не только во время работы агента. */}
          {workflow.view?.proposal?.status === 'ready' ? scenarioTexts.page.proposalEditingPaused : scenarioTexts.page.agentEditingPaused}
        </Alert>
      )}
      <Stack spacing={2} inert={workflow.busy || undefined} aria-busy={workflow.busy} sx={{ minWidth: 0 }}>
        {!scenes ? (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">{scenarioTexts.treatment.emptyHint}</Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap' }}>
              <ActionButton
                startIcon={<TimelineIcon />}
                onClick={partsFromTiming}
                disabled={busy || !view.timing}
                disabledReason={busy ? commonTexts.operationPending : scenarioTexts.prerequisites.timing}
              >
                {scenarioTexts.toolbar.partsFromTiming}
              </ActionButton>
              <Button startIcon={<AddIcon />} color="success" onClick={scenario.createScenario}>
                {scenarioTexts.treatment.createManually}
              </Button>
            </Stack>
          </Paper>
        ) : (
          <ScenarioPartsEditor
            scenes={scenes}
            setScenes={setScenes}
            expanded={partsOpen ?? !hasShots}
            onToggle={setPartsOpen}
            entityOptions={entityOptions}
            duration={duration}
            problems={hasShots ? [] : problems}
            busy={busy}
            hasTiming={!!view.timing}
            updatePart={updatePart}
            partsFromTiming={partsFromTiming}
          />
        )}
        {scenes && hasShots ? (
          <SceneRegistry
            resetKey={view.scenes}
            stickyTop={stickyTop}
            scenes={scenes}
            setScenes={setScenes}
            selected={selected}
            setSelected={setSelected}
            revealShot={revealShot}
            onRevealed={clearReveal}
            onOpenShotState={openShotState}
            leaveReason={unsavedDraftsReason(scenesDirty)}
            problems={problems}
            duration={duration}
            brief={brief}
            cast={cast}
            entityOptions={entityOptions}
            referenceOptions={referenceOptions}
            propertiesOf={propertiesOf}
            notify={notify}
            acceptedShots={workflow.view?.acceptedShots}
            shotNotice={
              selected && shotIssues.length ? (
                <Alert
                  severity="warning"
                  action={
                    <ActionButton
                      size="small"
                      color="inherit"
                      startIcon={<ArrowUpwardIcon />}
                      title={scenarioTexts.check.toReportHint}
                      onClick={() => setCheckFocus((current) => ({ index: shotIssues[0].index, seq: (current?.seq ?? 0) + 1 }))}
                    >
                      {scenarioTexts.check.toReport}
                    </ActionButton>
                  }
                >
                  <AlertTitle>{scenarioTexts.check.shotNotice({ shot: selected })}</AlertTitle>
                  {shotIssues.map(({ issue, index }) => (
                    <Typography key={index} variant="body2">
                      {scenarioTexts.check.severities[issue.severity]} · {issue.title}
                    </Typography>
                  ))}
                </Alert>
              ) : null
            }
          />
        ) : scenes ? (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">{scenarioTexts.page.noShots}</Typography>
          </Paper>
        ) : null}
      </Stack>
    </Stack>
  );
}
