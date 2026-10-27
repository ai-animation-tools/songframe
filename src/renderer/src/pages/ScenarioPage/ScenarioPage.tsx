import { type ReactElement, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { ScenarioToolbar, TreatmentEditor, SceneRegistry } from './components';
import { useScenario } from './useScenario';
import { useScenarioWorkflow } from './useScenarioWorkflow';
import { ScenarioWorkflowPanel } from './components/ScenarioWorkflowPanel';
import { PageActionBar } from '../../components/PageActionBar';
import ReplayIcon from '@mui/icons-material/Replay';

/** Сценарий связывает независимые черновики трактовки и реестра с их редакторами. */
export function ScenarioPage(): ReactElement {
  const scenario = useScenario();
  const workflow = useScenarioWorkflow(scenario.project, scenario.acceptWorkflowUpdate);
  const [showGlobal, setShowGlobal] = useState(false);
  const {
    view,
    loadError,
    retry,
    tab,
    setTab,
    treatment,
    setTreatment,
    scenes,
    setScenes,
    selected,
    setSelected,
    problems,
    brief,
    busy,
    cast,
    entityOptions,
    referenceOptions,
    propertiesOf,
    duration,
    scenesDirty,
    treatmentDirty,
    partsFromTiming,
    updatePart,
    saveTreatment,
    saveScenes,
    scaffold,
    copy,
    scaffoldProblem,
    notify
  } = scenario;

  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<ReplayIcon />} onClick={retry}>
            Повторить
          </Button>
        }
      >
        {loadError}
      </Alert>
    );
  if (!view)
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0, pb: 8 }}>
      <PageActionBar>
        <ScenarioToolbar
          tab={tab}
          onTabChange={setTab}
          treatment={treatment}
          scenes={scenes}
          busy={busy || workflow.busy}
          hasTiming={!!view.timing}
          scaffoldProblem={scaffoldProblem}
          treatmentDirty={treatmentDirty}
          scenesDirty={scenesDirty}
          problems={problems}
          showGlobal={showGlobal}
          onToggleGlobal={() => setShowGlobal((value) => !value)}
          partsFromTiming={partsFromTiming}
          saveTreatment={saveTreatment}
          saveScenes={saveScenes}
          scaffold={scaffold}
        />
      </PageActionBar>
      {view.problems.length ? <Alert severity="warning">{view.problems.join(' ')}</Alert> : null}
      {!cast ? <Alert severity="info">Сначала создайте кастинг: без сущностей нет референсов для планов и состояния героев.</Alert> : null}
      <ScenarioWorkflowPanel
        key={scenario.project}
        project={scenario.project}
        workflow={workflow}
        selected={selected}
        treatmentDirty={treatmentDirty}
        scenesDirty={scenesDirty}
        editorBusy={busy}
        onResolveDrafts={scenario.resolveWorkflowDrafts}
      />
      {workflow.busy && (
        <Alert severity="info">Агент работает с сохранёнными данными. Редактирование приостановлено до завершения или остановки задания.</Alert>
      )}
      <Box inert={workflow.busy || undefined} aria-busy={workflow.busy}>
        {tab === 'treatment' ? (
          <TreatmentEditor treatment={treatment} setTreatment={setTreatment} entityOptions={entityOptions} duration={duration} updatePart={updatePart} />
        ) : scenes ? (
          <SceneRegistry
            scenes={scenes}
            setScenes={setScenes}
            selected={selected}
            setSelected={setSelected}
            showGlobal={showGlobal}
            problems={problems}
            duration={duration}
            brief={brief}
            entityOptions={entityOptions}
            referenceOptions={referenceOptions}
            propertiesOf={propertiesOf}
            copy={copy}
            notify={notify}
          />
        ) : (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">Реестра сцен нет. Сохраните трактовку и постройте каркас.</Typography>
          </Paper>
        )}
      </Box>
    </Stack>
  );
}
