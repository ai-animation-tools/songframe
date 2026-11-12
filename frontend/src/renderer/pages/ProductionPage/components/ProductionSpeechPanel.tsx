import { productionTexts } from '@shared/texts/production';
/** Речь речевого плана: точный срез песни для липсинка готовится в пакете до запроса и сохраняется при приёмке. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Paper, Stack, TextField, Typography } from '@mui/material';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import HeadphonesIcon from '@mui/icons-material/Headphones';
import StopIcon from '@mui/icons-material/Stop';
import type { PackageSpeech, PackageView, SpeechPlan } from '@shared/types';
import { useApp } from '../../../state';
import { formatClock } from '../../../format';
import { ANCHORS } from '../../../components/linkTargets';
import { LinkedText } from '../../../components/LinkedText';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';

const seconds = productionTexts.productionSpeechPanel.seconds;

/**
 * Готовый срез речи: границы в песне и плеер WAV. Шаг «Речь» после нарезки сворачивается, поэтому следующий шаг
 * (ручная генерация) показывает тот же блок, чтобы срез можно было прослушать перед сборкой пакета.
 */
export function SpeechSlice({ speech }: { speech: PackageSpeech }): ReactElement {
  return (
    <Alert severity="success" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
      <Stack spacing={1}>
        <Typography variant="body1" fontWeight={600}>
          {productionTexts.productionSpeechPanel.ready({
            start: formatClock(speech.start),
            end: formatClock(speech.end),
            seconds: seconds(speech.end - speech.start)
          })}
        </Typography>
        <Box component="audio" controls preload="metadata" src={window.api.shell.fileUrl(speech.path)} sx={{ width: '100%', maxWidth: 520 }} />
      </Stack>
    </Alert>
  );
}

/**
 * Прослушивание участка песни по введённым границам, без записи файлов: скрытый audio трека играет от начала
 * и останавливается на конце. Конец проверяется каждый кадр, а не по timeupdate (раз в ~250 мс), чтобы
 * после границы не звучало лишнее. position — текущее время песни, null — участок не играет.
 */
function useSegmentPlayback(track: string | null, onError: (reason: unknown) => void) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const frame = useRef<number | null>(null);
  const [position, setPosition] = useState<number | null>(null);

  const stop = (): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    audio.current?.pause();
    setPosition(null);
  };

  // Смена трека и уход со страницы останавливают звук.
  useEffect(() => stop, [track]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = (start: number, end: number): void => {
    const element = audio.current;
    if (!element) return;
    stop();
    element.currentTime = start;
    setPosition(start);
    const tick = (): void => {
      if (element.paused || element.ended || element.currentTime >= end) {
        stop();
        return;
      }
      setPosition(element.currentTime);
      frame.current = requestAnimationFrame(tick);
    };
    element
      .play()
      .then(() => {
        frame.current = requestAnimationFrame(tick);
      })
      .catch((reason: unknown) => {
        stop();
        onError(reason);
      });
  };

  const element = track ? <Box component="audio" ref={audio} preload="metadata" src={window.api.shell.fileUrl(track)} hidden /> : null;
  return { element, position, play, stop };
}

export function ProductionSpeechPanel({
  project,
  pkg,
  busy,
  busyReason = BUSY_REASON,
  onPrepared
}: {
  project: string;
  pkg: PackageView;
  busy: boolean;
  /** Почему busy блокирует действия: идёт операция. */
  busyReason?: string;
  onPrepared(): Promise<void> | void;
}): ReactElement {
  const { notify, describeError } = useApp();
  const [plan, setPlan] = useState<SpeechPlan | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const speech = pkg.speech ?? null;

  useEffect(() => {
    let active = true;
    window.api.production
      .speechPlan(project, pkg.shot, pkg.dir)
      .then((next) => {
        if (active) setPlan(next);
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      });
    return () => {
      active = false;
    };
  }, [project, pkg.shot, pkg.dir, describeError]);

  // Поля показывают готовый срез, а без него — предложение по разметке.
  const bounds = speech ? { start: speech.start, end: speech.end } : (plan?.proposed ?? null);
  useEffect(() => {
    setStart(bounds ? String(bounds.start) : '');
    setEnd(bounds ? String(bounds.end) : '');
  }, [bounds?.start, bounds?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // Пакет ручной генерации уже содержит копию WAV: срез, как и у отправленного запроса, больше не меняется.
  const sent = !!pkg.request?.attemptStatus && pkg.request.attemptStatus !== 'prepared';
  const manual = pkg.request?.mode === 'manual';
  const startValue = Number(start.replace(',', '.'));
  const endValue = Number(end.replace(',', '.'));
  const rangeProblem =
    start.trim() === '' || end.trim() === '' || !Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue < 0 || endValue <= startValue;
  const boundsProblem = rangeProblem
    ? productionTexts.productionSpeechPanel.invalidRange
    : plan?.lipSync && (endValue - startValue < plan.lipSync.min - 1e-6 || endValue - startValue > plan.lipSync.max + 1e-6)
      ? productionTexts.productionSpeechPanel.duration({ min: plan.lipSync.min, max: plan.lipSync.max })
      : null;
  // Прослушивание не пишет файлов: ему мешают только неверные границы и отсутствие трека.
  const listenReason = !plan?.track ? productionTexts.productionSpeechPanel.noTrack : rangeProblem ? productionTexts.productionSpeechPanel.invalidRange : null;
  const playback = useSegmentPlayback(plan?.track ?? null, (reasonError) => {
    const text = productionTexts.productionSpeechPanel.listenFailed({ reason: describeError(reasonError) });
    setError(text);
    notify(text, 'error');
  });
  const sentReason = manual ? productionTexts.manualGeneration.builtSpeech : productionTexts.productionSpeechPanel.sent;
  const reason = sent ? sentReason : working ? BUSY_REASON : busy ? busyReason : boundsProblem;
  const lines = speech?.lines.length ? speech.lines : (plan?.lines ?? []);

  const prepare = async (): Promise<void> => {
    if (reason) return;
    setWorking(true);
    setError(null);
    try {
      await window.api.production.prepareSpeech(project, pkg.dir, { start: startValue, end: endValue });
      notify(productionTexts.productionSpeechPanel.prepared({ shot: pkg.shot, seconds: seconds(endValue - startValue) }), 'success');
      await onPrepared();
    } catch (reasonError) {
      const text = describeError(reasonError);
      setError(text);
      notify(text, 'error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-anchor={ANCHORS.productionSpeech}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <RecordVoiceOverIcon color="action" />
          <Typography variant="subtitle1" fontWeight={600}>
            {productionTexts.productionSpeechPanel.heading}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {productionTexts.productionSpeechPanel.description}
        </Typography>
        {plan ? (
          <Typography variant="caption" color="text.secondary">
            {productionTexts.productionSpeechPanel.window({ start: formatClock(plan.window.start), end: formatClock(plan.window.end) })}
          </Typography>
        ) : null}
        {lines.length ? (
          <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {lines.map((line) => (
              <Typography component="li" variant="body2" key={`${line.start}-${line.end}`}>
                {formatClock(line.start)}–{formatClock(line.end)} · {line.text ?? productionTexts.productionSpeechPanel.emptyLine}
              </Typography>
            ))}
          </Stack>
        ) : plan ? (
          <Alert severity="info">{productionTexts.productionSpeechPanel.noTiming}</Alert>
        ) : null}
        {speech ? <SpeechSlice speech={speech} /> : null}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <TextField
            label={productionTexts.productionSpeechPanel.cutStart}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            disabled={sent}
            sx={{ width: 160 }}
          />
          <TextField
            label={productionTexts.productionSpeechPanel.cutEnd}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            disabled={sent}
            sx={{ width: 160 }}
          />
        </Box>
        {error ? (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <ActionButton variant="contained" startIcon={<ContentCutIcon />} disabled={!!reason} disabledReason={reason} onClick={() => void prepare()}>
            {speech ? productionTexts.productionSpeechPanel.recut : productionTexts.productionSpeechPanel.prepare}
          </ActionButton>
          {playback.position !== null ? (
            <ActionButton startIcon={<StopIcon />} onClick={playback.stop}>
              {productionTexts.productionSpeechPanel.stop}
            </ActionButton>
          ) : (
            <ActionButton
              startIcon={<HeadphonesIcon />}
              disabled={!!listenReason}
              disabledReason={listenReason}
              onClick={() => playback.play(startValue, endValue)}
            >
              {productionTexts.productionSpeechPanel.listen}
            </ActionButton>
          )}
          {playback.position !== null ? (
            <Typography
              variant="body2"
              role="timer"
              aria-label={productionTexts.productionSpeechPanel.position}
              sx={{ alignSelf: 'center', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatClock(playback.position)}
            </Typography>
          ) : null}
          {plan?.proposed ? (
            <ActionButton
              startIcon={<RestartAltIcon />}
              disabled={sent || working}
              disabledReason={sent ? sentReason : BUSY_REASON}
              onClick={() => {
                setStart(String(plan.proposed!.start));
                setEnd(String(plan.proposed!.end));
              }}
            >
              {productionTexts.productionSpeechPanel.timing}
            </ActionButton>
          ) : null}
        </Stack>
        {playback.element}
      </Stack>
    </Paper>
  );
}
