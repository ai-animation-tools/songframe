/** Производство: планы, пакеты, решения и подтверждения платных действий. */
import type { ReactElement } from 'react';
import { Alert, Box, CircularProgress, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { AcceptResultDialog, PackageCard, ProductionShotCard, ProductionShotList, ProductionToolbar, RegenerateDialog, SendRequestDialog } from './components';
import { useProductionPage } from './useProductionPage';
import { acceptShownResult } from './decisions';
import { ProductionWorkflowPanel } from './components/ProductionWorkflowPanel';
import { JobStatus } from '../../components';
import { PageActionBar } from '../../components/PageActionBar';

export function ProductionPage(): ReactElement {
  const {
    project,
    view,
    selected,
    setSelected,
    jobs,
    noteFor,
    setNoteFor,
    busyFor,
    reportWorkflowBusy,
    workflowBusyFor,
    packageSelection,
    selectedPackage,
    selectPackage,
    filter,
    setFilter,
    acceptDialog,
    setAcceptDialog,
    acceptOptions,
    setAcceptOptions,
    confirmSend,
    setConfirmSend,
    confirmRequest,
    confirmRegenerate,
    setConfirmRegenerate,
    load,
    shot,
    visible,
    act,
    decide,
    selectImage,
    copy
  } = useProductionPage();

  if (!view) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0, pb: 8 }}>
      <PageActionBar>
        <ProductionToolbar view={view} filter={filter} onFilter={setFilter} onSelect={setSelected} onRefresh={() => void load()} />
      </PageActionBar>
      {view.problems.length ? <Alert severity="warning">{view.problems.join(' ')}</Alert> : null}
      {!view.tools.python ? (
        <Alert severity="info">Python не найден: просмотр работает, кнопки решений и отправки недоступны.</Alert>
      ) : !view.tools.kling ? (
        <Alert severity="info">Kling CLI не найден: отправка и получение результатов недоступны, подготовка и согласования работают.</Alert>
      ) : null}

      {/* Пока планов нет, предупреждение выше объясняет следующий шаг без пустых панелей выбора. */}
      {view.shots.length ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            '@container workspace (min-width: 1100px)': { gridTemplateColumns: '340px minmax(0, 1fr)' },
            gap: 2,
            alignItems: 'start'
          }}
        >
          <ProductionShotList shots={visible} selected={selected} onSelect={setSelected} />

          {shot ? (
            <Stack spacing={2} sx={{ minWidth: 0 }}>
              <ProductionShotCard
                shot={shot}
                busy={!!shot.packages.find((pkg) => busyFor(pkg.dir) || workflowBusyFor(pkg.dir))}
                pythonAvailable={view.tools.python}
                onCopy={copy}
                onRegenerate={setConfirmRegenerate}
              />

              <TextField
                select
                label="Пакет для просмотра и подготовки"
                value={packageSelection}
                onChange={(event) => selectPackage(event.target.value)}
                helperText="Выбор закреплён: новые попытки не меняют текущий пакет."
              >
                <MenuItem value="" disabled>
                  Выберите пакет
                </MenuItem>
                <MenuItem value="__new__">Новая подготовка</MenuItem>
                {shot.packages.map((pkg) => (
                  <MenuItem key={pkg.dir} value={pkg.dir}>
                    {pkg.relative} · {pkg.stageLabel}
                  </MenuItem>
                ))}
              </TextField>

              {packageSelection === '__new__' || selectedPackage ? (
                <ProductionWorkflowPanel
                  key={`${project}:${shot.id}:${packageSelection}`}
                  project={project}
                  shot={shot.id}
                  packageDir={selectedPackage?.dir}
                  decisionToken={selectedPackage?.decisionToken}
                  packageBusy={selectedPackage ? busyFor(selectedPackage.dir) : false}
                  onBusyChange={(value) => reportWorkflowBusy(packageSelection, value)}
                  onApplied={async (dir) => {
                    if (dir) selectPackage(dir);
                    await load();
                  }}
                />
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
                  onDecide={(verdict) => decide(selectedPackage, verdict)}
                  onSubmit={() => setConfirmSend(selectedPackage)}
                  onSelectImage={(index) => selectImage(selectedPackage, index)}
                  onAccept={() => setAcceptDialog({ shot: selectedPackage.shot, dir: selectedPackage.dir, resultToken: selectedPackage.resultToken })}
                  onContactSheet={() => act('Сводка запущена', () => window.api.production.contactSheet(project, selectedPackage.dir), selectedPackage.dir)}
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

      <JobStatus running={jobs.some((job) => job.status === 'running')} />

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
        onClose={() => setConfirmRegenerate(null)}
        onConfirm={() => {
          const id = confirmRegenerate!;
          setConfirmRegenerate(null);
          void act('Подготовка повтора запущена', () => window.api.production.regenerate(project, id), selectedPackage?.dir);
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
