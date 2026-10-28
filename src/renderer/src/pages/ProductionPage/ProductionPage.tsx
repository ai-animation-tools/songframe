/** Производство: планы, пакеты, решения и подтверждения платных действий. */
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, CircularProgress, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { AcceptResultDialog, PackageCard, ProductionShotCard, ProductionShotList, ProductionToolbar, RegenerateDialog, SendRequestDialog } from './components';
import { useProductionPage } from './useProductionPage';
import { acceptShownResult, isQueuedPackage } from './decisions';
import { ProductionWorkflowPanel } from './components/ProductionWorkflowPanel';
import { aiActionProblem } from '@shared/ai-access';
import { useApp } from '../../state';
import { PageActionBar } from '../../components/PageActionBar';
import { ProductionQueue } from './components/ProductionQueue';

export function ProductionPage(): ReactElement {
  const workflowPanel = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const { aiAccess } = useApp();
  const aiProblems = [...new Set((['agent', 'image', 'video'] as const).map((kind) => aiActionProblem(aiAccess, kind)).filter(Boolean))];
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
    selectImage
  } = useProductionPage();

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    // Высота панели меняется при переносе фильтров: закреплённый блок плана остаётся под ней.
    const updateHeight = (): void => setToolbarHeight(toolbar.getBoundingClientRect().height);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    updateHeight();
    return () => observer.disconnect();
  }, [view]);

  // Отступ закреплённого блока и прокрутки к карточке: шапка, панель действий и зазор сетки.
  const stickyTop = 49 + toolbarHeight + 16;

  if (!view) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0, pb: 8, '--shot-card-scroll-margin': `${stickyTop}px` }}>
      <PageActionBar barRef={toolbarRef}>
        <ProductionToolbar view={view} filter={filter} onFilter={setFilter} onSelect={setSelected} onRefresh={() => void load()} />
      </PageActionBar>
      {aiProblems.length ? <Alert severity="info">{aiProblems.join(' ')}</Alert> : null}
      {view.problems.length ? <Alert severity="warning">{view.problems.join(' ')}</Alert> : null}
      {!view.tools.python ? (
        <Alert severity="info">Python не найден: просмотр работает, кнопки решений и отправки недоступны.</Alert>
      ) : !view.tools.kling ? (
        <Alert severity="info">Kling не найден: отправка и получение результатов недоступны, подготовка и согласования работают.</Alert>
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
                label="Пакет для просмотра и подготовки"
                value={packageSelection}
                onChange={(event) => selectPackage(event.target.value)}
                helperText="Выбор закреплён: пакеты, созданные агентом, не переключают просмотр. Новая попытка после «Подготовить повтор» открывается сама."
              >
                <MenuItem value="" disabled>
                  Выберите пакет
                </MenuItem>
                <MenuItem value="__new__">Новая подготовка</MenuItem>
                {shot.packages.map((pkg) => (
                  <MenuItem key={pkg.dir} value={pkg.dir}>
                    {isQueuedPackage(pkg) ? 'В очереди · ' : ''}
                    {pkg.relative} · {pkg.stageLabel}
                  </MenuItem>
                ))}
              </TextField>

              {packageSelection === '__new__' || selectedPackage ? (
                <Box ref={workflowPanel} tabIndex={-1}>
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
                <Alert severity="info">Выберите пакет, чтобы увидеть материалы, согласования и действия агента.</Alert>
              )}

              {selectedPackage ? (
                <PackageCard
                  key={selectedPackage.dir}
                  pkg={selectedPackage}
                  note={noteFor(selectedPackage)}
                  setNote={(value) => setNoteFor(selectedPackage, value)}
                  busy={busyFor(selectedPackage.dir) || workflowBusyFor(selectedPackage.dir) || !view.tools.python}
                  operation={operationFor(selectedPackage.dir)}
                  onOpenRevision={() => {
                    const panel = workflowPanel.current;
                    const target = panel?.querySelector<HTMLTextAreaElement>('textarea') ?? panel;
                    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target?.focus({ preventScroll: true });
                  }}
                  onDecide={(verdict) => decide(selectedPackage, verdict)}
                  onSubmit={() => setConfirmSend(selectedPackage)}
                  onSelectImage={(index) => selectImage(selectedPackage, index)}
                  onAccept={() =>
                    setAcceptDialog({ shot: selectedPackage.shot, dir: selectedPackage.dir, resultToken: selectedPackage.resultToken, hasAsset: !!shot.asset })
                  }
                  onContactSheet={() => act('Сводка запущена', () => window.api.production.contactSheet(project, selectedPackage.dir), selectedPackage.dir)}
                  onReopenQuestion={() =>
                    act('Вопрос о результате задан снова', () => window.api.production.reopenQuestion(project, selectedPackage.dir), selectedPackage.dir)
                  }
                  onDiscard={() => discardPackage(selectedPackage)}
                  onResume={(id) =>
                    act('Получение результата запущено', () => window.api.production.resume(project, selectedPackage.dir, id), selectedPackage.dir)
                  }
                  klingAvailable={view.tools.kling}
                />
              ) : null}
            </Stack>
          ) : (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Typography color="text.secondary">Выберите план.</Typography>
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
          void act('Подготовка повтора запущена', () => window.api.production.regenerate(project, id), '', id);
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
          void act('Приёмка запущена', () => acceptShownResult(window.api, project, target, acceptOptions), target.dir);
        }}
      />
    </Stack>
  );
}
