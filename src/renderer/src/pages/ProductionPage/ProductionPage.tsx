import { productionTexts } from '@shared/texts/production';
/** Производство: планы, пакеты, решения и подтверждения платных действий. */
import { useRef, type ReactElement } from 'react';
import { usePageLoading } from '../../components/PageLoader';
import { Alert, Box, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { AiProblemAlert } from '../../components';
import { AcceptResultDialog, PackageCard, ProductionShotCard, ProductionShotList, ProductionToolbar, RegenerateDialog, SendRequestDialog } from './components';
import { useProductionPage } from './useProductionPage';
import { acceptShownResult, isQueuedPackage } from './decisions';
import { ProductionWorkflowPanel } from './components/ProductionWorkflowPanel';
import { ProductionSpeechPanel } from './components/ProductionSpeechPanel';
import { PageActionBar } from '../../components/PageActionBar';
import { ProductionQueue } from './components/ProductionQueue';
import { useStickyTop } from '../../hooks/useStickyTop';
import { ANCHORS } from '../../components/linkTargets';
import { LinkedText } from '../../components/LinkedText';
import { BUSY_REASON, PYTHON_REASON } from './constants';

export function ProductionPage(): ReactElement {
  const workflowPanel = useRef<HTMLDivElement>(null);
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
    reopenFrame,
    keepPackageForScene,
    setKeyframeNote,
    selectImage
  } = useProductionPage();

  // Отступ закреплённого блока и прокрутки к карточке: шапка, панель действий и зазор сетки.
  const { barRef: toolbarRef, stickyTop } = useStickyTop([view]);

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view);
  if (!view) return <></>;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0, pb: 8, '--shot-card-scroll-margin': `${stickyTop}px` }}>
      <PageActionBar barRef={toolbarRef}>
        <ProductionToolbar view={view} filter={filter} onFilter={setFilter} onRefresh={() => void load()} />
      </PageActionBar>
      <AiProblemAlert kinds={['agent', 'image', 'video']} />
      {view.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {!view.tools.python ? (
        <Alert severity="info">{productionTexts.productionPage.pythonMissing}</Alert>
      ) : !Object.values(view.tools.providers).every(Boolean) ? (
        <Alert severity="info">{productionTexts.productionPage.paidProviderMissing}</Alert>
      ) : null}

      {/* Пока планов нет, предупреждение выше объясняет следующий шаг без пустых панелей выбора. */}
      {view.shots.length ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            // Колонки как на странице «Сцены»: при широком окне выбранный план справа, список слева в три карточки.
            '@container workspace (min-width: 1100px)': { gridTemplateColumns: shot ? 'minmax(0, 1fr) minmax(0, 1.4fr)' : 'minmax(0, 1fr)' },
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
              <ProductionShotCard
                shot={shot}
                busy={busyFor('') || !!shot.packages.find((pkg) => busyFor(pkg.dir) || workflowBusyFor(pkg.dir))}
                operation={operationFor()}
                pythonAvailable={view.tools.python}
                onRegenerate={setConfirmRegenerate}
                selectedPackage={packageSelection}
                onOpenPackage={selectPackage}
                broken={view.broken.filter((item) => item.shot === shot.id)}
                onDiscardBroken={discardBroken}
              />

              <TextField
                select
                label={productionTexts.productionPage.packageLabel}
                value={packageSelection}
                onChange={(event) => selectPackage(event.target.value)}
                helperText={productionTexts.productionPage.packageSelectionHint}
              >
                <MenuItem value="" disabled>
                  {productionTexts.productionPage.choosePackage}
                </MenuItem>
                <MenuItem value="__new__">{productionTexts.productionPage.newPreparation}</MenuItem>
                {shot.packages.map((pkg) => (
                  <MenuItem key={pkg.dir} value={pkg.dir}>
                    {productionTexts.productionPage.queuedPrefix({ queued: isQueuedPackage(pkg), relative: pkg.relative, stage: pkg.stageLabel })}
                  </MenuItem>
                ))}
              </TextField>

              {packageSelection === '__new__' || selectedPackage ? (
                <Box ref={workflowPanel} tabIndex={-1} data-anchor={ANCHORS.productionWorkflow}>
                  <ProductionWorkflowPanel
                    key={`${project}:${shot.id}:${packageSelection}`}
                    project={project}
                    shot={shot.id}
                    packageDir={selectedPackage?.dir}
                    decisionToken={selectedPackage?.decisionToken}
                    decision={selectedPackage?.decision}
                    packageBusy={selectedPackage ? busyFor(selectedPackage.dir) : false}
                    onBusyChange={(value) => reportWorkflowBusy(packageSelection, value)}
                    onApplied={async (dir) => {
                      if (dir) selectPackage(dir);
                      await load();
                    }}
                  />
                </Box>
              ) : (
                <Alert severity="info">{productionTexts.productionPage.choosePackageHint}</Alert>
              )}

              {/* Речевому плану нужен точный срез песни до подготовки запроса и для приёмки. */}
              {selectedPackage && shot.lipsync ? (
                <ProductionSpeechPanel
                  key={`speech:${selectedPackage.dir}`}
                  project={project}
                  pkg={selectedPackage}
                  busy={busyFor(selectedPackage.dir) || workflowBusyFor(selectedPackage.dir) || !view.tools.python}
                  busyReason={view.tools.python ? BUSY_REASON : PYTHON_REASON}
                  onPrepared={load}
                />
              ) : null}

              {selectedPackage ? (
                <PackageCard
                  key={selectedPackage.dir}
                  pkg={selectedPackage}
                  note={noteFor(selectedPackage)}
                  setNote={(value) => setNoteFor(selectedPackage, value)}
                  busy={busyFor(selectedPackage.dir) || workflowBusyFor(selectedPackage.dir) || !view.tools.python}
                  busyReason={view.tools.python ? BUSY_REASON : PYTHON_REASON}
                  operation={operationFor(selectedPackage.dir)}
                  onOpenRevision={(focusNote = true) => {
                    const panel = workflowPanel.current;
                    const target = (focusNote ? panel?.querySelector<HTMLTextAreaElement>('textarea') : null) ?? panel;
                    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target?.focus({ preventScroll: true });
                  }}
                  onDecide={(verdict, noteScope) => decide(selectedPackage, verdict, noteScope)}
                  onReopenFrame={(frame, note, scope) => reopenFrame(selectedPackage, frame, note, scope)}
                  onKeepForScene={() => keepPackageForScene(selectedPackage)}
                  onSetKeyframeNote={(id, active) => setKeyframeNote(selectedPackage, id, active)}
                  onSubmit={() => setConfirmSend(selectedPackage)}
                  onSelectImage={(index) => selectImage(selectedPackage, index)}
                  onAccept={() => openAccept(selectedPackage, !!shot.asset, shot.lipsync)}
                  onContactSheet={() =>
                    act(
                      productionTexts.productionPage.summaryStarted,
                      () => window.api.production.contactSheet(project, selectedPackage.dir),
                      selectedPackage.dir
                    )
                  }
                  onReopenQuestion={() =>
                    act(
                      productionTexts.productionPage.resultQuestionReopened,
                      () => window.api.production.reopenQuestion(project, selectedPackage.dir),
                      selectedPackage.dir
                    )
                  }
                  onDiscard={() => discardPackage(selectedPackage)}
                  onResume={() =>
                    act(productionTexts.productionPage.resumeStarted, () => window.api.production.resume(project, selectedPackage.dir), selectedPackage.dir)
                  }
                  onAttachResult={(files) =>
                    act(
                      productionTexts.productionPage.importStarted,
                      () => window.api.production.attachResult(project, selectedPackage.dir, files),
                      selectedPackage.dir
                    )
                  }
                  onNotCreated={() =>
                    act(
                      productionTexts.productionPage.submissionReset,
                      () => window.api.production.markNotCreated(project, selectedPackage.dir),
                      selectedPackage.dir
                    )
                  }
                  providers={view.tools.providers}
                />
              ) : null}
            </Stack>
          ) : (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Typography color="text.secondary">{productionTexts.productionPage.chooseShot}</Typography>
            </Paper>
          )}
        </Box>
      ) : null}

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
