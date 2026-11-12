import { productionTexts } from '@shared/texts/production';
/** Производство: список планов и один путь выбранного плана с решениями и подтверждениями платных действий. */
import { useState, type ReactElement } from 'react';
import { usePageLoading } from '../../components/PageLoader';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import { AiProblemAlert } from '../../components';
import {
  AcceptResultDialog,
  DerivedShotPanel,
  FragmentPreviewDialog,
  ProductionPath,
  ProductionOperationNotice,
  ProductionShotCard,
  ProductionShotList,
  ProductionToolbar,
  RegenerateDialog,
  SendRequestDialog
} from './components';
import { useProductionPage } from './useProductionPage';
import { acceptShownResult } from './decisions';
import type { PlanPath } from './planPath';
import { PageActionBar } from '../../components/PageActionBar';
import { ProductionQueue } from './components/ProductionQueue';
import { useStickyTop } from '../../hooks/useStickyTop';
import { ANCHORS } from '../../components/linkTargets';
import { LinkedText } from '../../components/LinkedText';
import { BUSY_REASON } from './constants';

export function ProductionPage(): ReactElement {
  const [path, setPath] = useState<{ key: string; value: PlanPath } | null>(null);
  const [fragmentOpen, setFragmentOpen] = useState(false);
  const {
    project,
    view,
    selected,
    setSelected,
    noteFor,
    setNoteFor,
    busyFor,
    operationFor,
    reportWorkflowBusy,
    workflowBusyFor,
    packageSelection,
    selectedPackage,
    newAttempt,
    selectPackage,
    filter,
    setFilter,
    queued,
    openQueuedPackage,
    acceptDialog,
    setAcceptDialog,
    openAccept,
    acceptOptions,
    setAcceptOptions,
    confirmSend,
    setConfirmSend,
    confirmRequest,
    confirmRegenerate,
    setConfirmRegenerate,
    discardPackage,
    discardBroken,
    load,
    shot,
    visible,
    act,
    decide,
    answerApplied,
    reopenFrame,
    reopenPrompt,
    keepPackageForScene,
    setKeyframeNote,
    selectImage
  } = useProductionPage();

  // Отступ закреплённого блока и прокрутки к карточке: шапка, панель действий и зазор сетки.
  const { barRef: toolbarRef, stickyTop } = useStickyTop([view]);

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view);
  if (!view) return <></>;
  // Смена плана или попытки сбрасывает черновики пути и устаревшую фразу шапки.
  const pathKey = `${project}:${shot?.id ?? ''}:${packageSelection}`;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0, pb: 8, '--shot-card-scroll-margin': `${stickyTop}px` }}>
      <PageActionBar barRef={toolbarRef}>
        <ProductionToolbar view={view} filter={filter} onFilter={setFilter} onRefresh={() => void load()} />
      </PageActionBar>
      {!shot?.derivedFrom ? <AiProblemAlert kinds={['agent', 'image', 'video']} /> : null}
      {view.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {shot?.derivedFrom ? null : !Object.values(view.tools.providers).every(Boolean) ? (
        <Alert severity="info">{productionTexts.productionPage.paidProviderMissing}</Alert>
      ) : null}

      {/* Пока планов нет, предупреждение выше объясняет следующий шаг без пустых панелей выбора. */}
      {view.shots.length ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            // При широком окне выбранный план справа: основная работа здесь, список планов — узкая колонка.
            '@container workspace (min-width: 1100px)': { gridTemplateColumns: shot ? 'minmax(240px, 280px) minmax(0, 1fr)' : 'minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start'
          }}
        >
          {filter === 'queued' ? (
            <ProductionQueue
              packages={queued}
              broken={view.broken}
              selected={packageSelection}
              busy={busyFor('')}
              onOpen={openQueuedPackage}
              onDiscardBroken={discardBroken}
              onResetFilter={() => setFilter('all')}
            />
          ) : (
            <ProductionShotList
              shots={visible}
              selected={selected}
              onSelect={setSelected}
              filter={filter}
              onResetFilter={() => setFilter('all')}
              withDetails={!!shot}
            />
          )}

          {shot ? (
            // При двух колонках блок плана закреплён под панелью действий и прокручивается внутри себя,
            // чтобы длинный список карточек не уводил его за пределы окна.
            <Stack
              spacing={2}
              sx={{
                minWidth: 0,
                '@container workspace (min-width: 1100px)': {
                  position: 'sticky',
                  top: stickyTop,
                  maxHeight: `calc(100vh - ${stickyTop + 16}px)`,
                  overflowY: 'auto',
                  pr: 0.5
                }
              }}
            >
              {selectedPackage ? <ProductionOperationNotice operation={operationFor(selectedPackage.dir)} stickyTop={stickyTop} /> : null}
              <ProductionShotCard
                shot={shot}
                busy={busyFor('') || !!shot.packages.find((pkg) => busyFor(pkg.dir) || workflowBusyFor(pkg.dir))}
                operation={operationFor()}
                onRegenerate={setConfirmRegenerate}
                selectedPackage={packageSelection}
                onOpenPackage={selectPackage}
                broken={view.broken.filter((item) => item.shot === shot.id)}
                onDiscardBroken={discardBroken}
                now={shot.derivedFrom || path?.key !== pathKey ? null : { text: path.value.now, tone: path.value.tone }}
                onNewAttempt={shot.derivedFrom || (!shot.packages.length && !shot.asset) ? undefined : () => selectPackage('__new__')}
                onDiscardAttempt={discardPackage}
                onFragment={() => setFragmentOpen(true)}
              />

              {shot.derivedFrom ? (
                <DerivedShotPanel key={`${project}:${shot.id}`} project={project} shot={shot.id} onApplied={load} />
              ) : (
                <Box tabIndex={-1} data-anchor={ANCHORS.productionWorkflow}>
                  <ProductionPath
                    key={pathKey}
                    project={project}
                    shot={shot}
                    pkg={selectedPackage}
                    packageSelection={packageSelection}
                    newAttempt={newAttempt}
                    note={selectedPackage ? noteFor(selectedPackage) : ''}
                    setNote={(value) => selectedPackage && setNoteFor(selectedPackage, value)}
                    busy={selectedPackage ? busyFor(selectedPackage.dir) : false}
                    busyReason={BUSY_REASON}
                    providers={view.tools.providers}
                    speechBusy={!!selectedPackage && (busyFor(selectedPackage.dir) || workflowBusyFor(selectedPackage.dir))}
                    onBusyChange={(value) => reportWorkflowBusy(packageSelection, value)}
                    onApplied={async (dir) => {
                      if (dir) selectPackage(dir);
                      await load();
                    }}
                    onPath={(value) => setPath({ key: pathKey, value })}
                    answerApplied={answerApplied}
                    onDecide={(verdict, noteScope, after) => selectedPackage && decide(selectedPackage, verdict, noteScope, after)}
                    onReopenFrame={(frame, note, scope) => selectedPackage && reopenFrame(selectedPackage, frame, note, scope)}
                    onReopenPrompt={(note) => selectedPackage && reopenPrompt(selectedPackage, note)}
                    onKeepForScene={() => selectedPackage && keepPackageForScene(selectedPackage)}
                    onSetKeyframeNote={(id, active) => selectedPackage && setKeyframeNote(selectedPackage, id, active)}
                    onSubmit={() => setConfirmSend(selectedPackage)}
                    onSelectImage={(index) => selectedPackage && selectImage(selectedPackage, index)}
                    onAccept={() => selectedPackage && openAccept(selectedPackage, !!shot.asset, shot.lipsync)}
                    onRegenerate={() => setConfirmRegenerate(shot.id)}
                    onContactSheet={() =>
                      selectedPackage &&
                      act(
                        productionTexts.productionPage.summaryStarted,
                        () => window.api.production.contactSheet(project, selectedPackage.dir),
                        selectedPackage.dir
                      )
                    }
                    onResume={() =>
                      selectedPackage &&
                      act(productionTexts.productionPage.resumeStarted, () => window.api.production.resume(project, selectedPackage.dir), selectedPackage.dir)
                    }
                    onAttachResult={(files) =>
                      selectedPackage &&
                      act(
                        productionTexts.productionPage.importStarted,
                        () => window.api.production.attachResult(project, selectedPackage.dir, files),
                        selectedPackage.dir
                      )
                    }
                    onAttachManual={(video) =>
                      selectedPackage &&
                      act(
                        productionTexts.manualGeneration.started,
                        () => window.api.production.attachManual(project, selectedPackage.dir, video),
                        selectedPackage.dir
                      )
                    }
                    onNotCreated={() =>
                      selectedPackage &&
                      act(
                        productionTexts.productionPage.submissionReset,
                        () => window.api.production.markNotCreated(project, selectedPackage.dir),
                        selectedPackage.dir
                      )
                    }
                    onSpeechPrepared={load}
                  />
                </Box>
              )}
            </Stack>
          ) : (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Typography color="text.secondary">{productionTexts.productionPage.chooseShot}</Typography>
            </Paper>
          )}
        </Box>
      ) : null}

      {/* Ключ по проекту: задание и выбор фрагмента не переходят в другой проект. */}
      <FragmentPreviewDialog
        key={project}
        open={fragmentOpen}
        project={project}
        shots={view.shots}
        initialShot={selected}
        onClose={() => setFragmentOpen(false)}
      />

      <SendRequestDialog
        key={`${project}:${confirmSend?.dir ?? ''}:${confirmSend?.decisionToken ?? ''}:${confirmSend ? 'open' : 'closed'}`}
        project={project}
        pkg={confirmSend}
        busy={!!confirmSend && busyFor(confirmSend.dir)}
        onClose={() => setConfirmSend(null)}
        onConfirm={confirmRequest}
      />

      <RegenerateDialog
        shot={confirmRegenerate}
        problem={view.shots.find((item) => item.id === confirmRegenerate)?.regenerateProblem}
        onClose={() => setConfirmRegenerate(null)}
        onConfirm={() => {
          const id = confirmRegenerate!;
          setConfirmRegenerate(null);
          void act(productionTexts.productionPage.retryStarted, () => window.api.production.regenerate(project, id), '', id);
        }}
      />

      <AcceptResultDialog
        target={acceptDialog}
        options={acceptOptions}
        onOptions={setAcceptOptions}
        onClose={() => setAcceptDialog(null)}
        onConfirm={() => {
          const target = acceptDialog!;
          setAcceptDialog(null);
          void act(productionTexts.productionPage.acceptanceStarted, () => acceptShownResult(window.api, project, target, acceptOptions), target.dir);
        }}
      />
    </Stack>
  );
}
