/** Локальная приёмка повторяет контракт страницы: запуск задания ещё не меняет принятый комплект. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { Api } from '@shared/api';
import type { AcceptOptions, JobInfo, PackageView } from '@shared/types';
import { FPS } from '@shared/video';
import { ActionButton } from '../components/ActionButton';
import { AcceptResultDialog } from '../pages/ProductionPage/components/AcceptResultDialog';
import { acceptShownResult, acceptTargetFor, defaultAcceptOptions, type AcceptTarget } from '../pages/ProductionPage/decisions';
import { DELIVERY_PROJECT, DELIVERY_RESULT_TOKEN, deliveryJob, deliveryPackage, assertDeliveryAcceptOptions } from './deliveryStories';
import { createStoryApi } from './storybook';

export interface AcceptResultStoryProps {
  hasAsset?: boolean;
  windowFrames?: number;
  missingToken?: boolean;
  speechMissing?: boolean;
  changedAfterOpen?: boolean;
  failFirst?: boolean;
  delay?: number;
}

export function AcceptResultStory({
  hasAsset = false,
  windowFrames = 150,
  missingToken = false,
  speechMissing = false,
  changedAfterOpen = false,
  failFirst = false,
  delay = 850
}: AcceptResultStoryProps) {
  const makePackage = (): PackageView => {
    const pkg = deliveryPackage();
    return {
      ...pkg,
      resultToken: missingToken ? undefined : DELIVERY_RESULT_TOKEN,
      timing: { ...pkg.timing!, frames: windowFrames, window_seconds: windowFrames / FPS }
    };
  };
  const [pkg, setPackage] = useState(makePackage);
  const [target, setTarget] = useState<AcceptTarget | null>(null);
  const [options, setOptions] = useState<AcceptOptions>({ mode: 'full' });
  const [job, setJob] = useState<JobInfo | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const [submitted, setSubmitted] = useState<AcceptOptions | null>(null);
  const backend = useRef({ token: pkg.resultToken, running: false, failed: false, changed: false, epoch: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [session] = useState(() => {
    // Проверки снимка и согласия принадлежат mock production.accept, как и в главном процессе.
    const accept: Api['production']['accept'] = async (project, shot, dir, incoming) => {
      setCalls((count) => count + 1);
      if (project !== DELIVERY_PROJECT || shot !== pkg.shot || dir !== pkg.dir) throw new Error('Пакет не относится к показанному плану.');
      if (!incoming.expectedResultToken || incoming.expectedResultToken !== backend.current.token)
        throw new Error('Результат изменился. Обновите пакет и просмотрите его перед приёмкой.');
      if (hasAsset && !incoming.replaceExisting) throw new Error('У плана уже есть принятый комплект. Подтвердите замену.');
      if (speechMissing) throw new Error('Речевой план: сначала подготовьте WAV речи.');
      if (backend.current.running) throw new Error('Приёмка этого пакета уже выполняется.');
      assertDeliveryAcceptOptions(incoming);
      backend.current.running = true;
      setSubmitted({ ...incoming });
      return deliveryJob('accept');
    };
    return createStoryApi({ production: { accept } });
  });
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      backend.current.epoch++;
      session.dispose();
    },
    [session]
  );

  const open = (): void => {
    if (backend.current.running || accepted) return;
    const next = acceptTargetFor(pkg, hasAsset, speechMissing);
    setOptions(defaultAcceptOptions(next));
    setTarget(next);
    setNotice(null);
    if (changedAfterOpen && !backend.current.changed) {
      backend.current.changed = true;
      backend.current.token = 'e'.repeat(64);
    }
  };
  const confirm = async (): Promise<void> => {
    if (!target || backend.current.running) return;
    const shown = target;
    const epoch = backend.current.epoch;
    setTarget(null);
    setNotice(null);
    try {
      const started = await acceptShownResult(session.api, DELIVERY_PROJECT, shown, options);
      if (epoch !== backend.current.epoch) return;
      setJob(started);
      // Комплект публикуется только по done; failed оставляет прежний комплект и оригинал попытки.
      timer.current = setTimeout(() => {
        timer.current = null;
        backend.current.running = false;
        const fail = failFirst && !backend.current.failed;
        backend.current.failed = true;
        setJob({ ...started, status: fail ? 'failed' : 'done', finishedAt: '2026-10-30T09:00:01.000Z', code: fail ? 1 : 0 });
        if (fail) setNotice('Приёмка завершилась с ошибкой. Прежний комплект и оригинал попытки сохранены; повторите приёмку.');
        else setAccepted(true);
      }, delay);
    } catch (error) {
      if (epoch === backend.current.epoch) setNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const reset = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    backend.current = {
      token: missingToken ? undefined : DELIVERY_RESULT_TOKEN,
      running: false,
      failed: false,
      changed: false,
      epoch: backend.current.epoch + 1
    };
    setPackage(makePackage());
    setTarget(null);
    setOptions({ mode: 'full' });
    setJob(null);
    setAccepted(false);
    setNotice(null);
    setCalls(0);
    setSubmitted(null);
  };
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6">Приёмка результата M02</Typography>
          <Typography>Оригинал попытки: 8 секунд, 240 кадров. Окно плана: {windowFrames / FPS} с.</Typography>
          <Typography>
            {accepted ? 'Принятый комплект: новый результат.' : hasAsset ? 'Принятый комплект: прежний результат.' : 'Принятого комплекта пока нет.'}
          </Typography>
          <Typography>Оригинал попытки сохранён.</Typography>
          {accepted && hasAsset ? <Typography>Прежний комплект сохранён в assets/replaced/M02.</Typography> : null}
          {job ? <Alert severity={job.status === 'failed' ? 'error' : job.status === 'done' ? 'success' : 'info'}>Задание приёмки: {job.status}.</Alert> : null}
          {notice ? <Alert severity="error">{notice}</Alert> : null}
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            <ActionButton
              variant="contained"
              disabled={job?.status === 'running' || accepted}
              disabledReason={accepted ? 'Показанный результат уже принят.' : 'Дождитесь завершения приёмки.'}
              onClick={open}
            >
              Открыть приёмку
            </ActionButton>
            {changedAfterOpen ? (
              <ActionButton
                disabled={job?.status === 'running' || accepted}
                onClick={() => {
                  setPackage((current) => ({ ...current, resultToken: backend.current.token }));
                  setNotice('Обновлённый результат просмотрен: можно открыть приёмку заново.');
                }}
              >
                Обновить пакет и просмотреть результат
              </ActionButton>
            ) : null}
            <ActionButton onClick={reset}>Сбросить модель</ActionButton>
          </Stack>
          <Typography variant="caption">Вызовы production.accept: {calls}.</Typography>
          {submitted ? (
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              Переданные параметры: {JSON.stringify(submitted)}
            </Typography>
          ) : null}
        </Stack>
      </Paper>
      <AcceptResultDialog
        target={target}
        options={options}
        onOptions={setOptions}
        onClose={() => setTarget(null)}
        onConfirm={() => {
          void confirm();
        }}
      />
    </Stack>
  );
}
