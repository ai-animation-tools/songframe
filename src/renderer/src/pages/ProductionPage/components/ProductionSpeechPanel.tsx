/** Речь речевого плана: точный срез песни для липсинка готовится в пакете до запроса и сохраняется при приёмке. */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Paper, Stack, TextField, Typography } from '@mui/material';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { PackageView, SpeechPlan } from '@shared/types';
import { useApp } from '../../../state';
import { formatClock } from '../../../format';
import { ANCHORS } from '../../../components/linkTargets';
import { LinkedText } from '../../../components/LinkedText';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';

const seconds = (value: number): string => `${value.toFixed(2).replace('.', ',')} с`;

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
  /** Почему busy блокирует действия: идёт операция или нет Python. */
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

  const sent = !!pkg.request?.attemptStatus && pkg.request.attemptStatus !== 'prepared';
  const startValue = Number(start.replace(',', '.'));
  const endValue = Number(end.replace(',', '.'));
  const boundsProblem =
    start.trim() === '' || end.trim() === '' || !Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue < 0 || endValue <= startValue
      ? 'Укажите начало и конец среза в секундах; конец позже начала.'
      : plan && !plan.lipSync
        ? 'Провайдер видео проекта не синхронизирует губы с заданным звуком.'
        : plan?.lipSync && (endValue - startValue < plan.lipSync.min - 1e-6 || endValue - startValue > plan.lipSync.max + 1e-6)
          ? `Провайдер видео принимает звук длиной от ${plan.lipSync.min} до ${plan.lipSync.max} с.`
          : null;
  const sentReason = 'Запрос этой попытки уже отправлен: её WAV менять нельзя.';
  const reason = sent ? sentReason : working ? BUSY_REASON : busy ? busyReason : boundsProblem;
  const lines = speech?.lines.length ? speech.lines : (plan?.lines ?? []);

  const prepare = async (): Promise<void> => {
    if (reason) return;
    setWorking(true);
    setError(null);
    try {
      await window.api.production.prepareSpeech(project, pkg.dir, { start: startValue, end: endValue });
      notify(`WAV речи ${pkg.shot} подготовлен: ${seconds(endValue - startValue)}.`, 'success');
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
            Речь (липсинк)
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Губы синхронизируются с точным фрагментом песни. Срез берётся из исходного трека без обработки и начинается с начала окна плана, поэтому в монтаже
          губы совпадут с песней. Он уходит в запрос звуковым входом и сохраняется в комплекте при приёмке. Прослушайте срез перед подготовкой запроса.
        </Typography>
        {plan ? (
          <Typography variant="caption" color="text.secondary">
            Окно плана: {formatClock(plan.window.start)}–{formatClock(plan.window.end)}
          </Typography>
        ) : null}
        {lines.length ? (
          <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {lines.map((line) => (
              <Typography component="li" variant="body2" key={`${line.start}-${line.end}`}>
                {formatClock(line.start)}–{formatClock(line.end)} · {line.text ?? 'строка без текста'}
              </Typography>
            ))}
          </Stack>
        ) : plan ? (
          <Alert severity="info">В окне плана нет строк разметки: задайте границы среза вручную.</Alert>
        ) : null}
        {speech ? (
          <Stack spacing={0.5}>
            <Typography variant="body2">
              Подготовлен срез {formatClock(speech.start)}–{formatClock(speech.end)} ({seconds(speech.end - speech.start)}).
            </Typography>
            <Box component="audio" controls preload="metadata" src={window.api.shell.fileUrl(speech.path)} sx={{ width: '100%', maxWidth: 520 }} />
          </Stack>
        ) : null}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <TextField label="Начало, с" value={start} onChange={(event) => setStart(event.target.value)} disabled={sent} sx={{ width: 160 }} />
          <TextField label="Конец, с" value={end} onChange={(event) => setEnd(event.target.value)} disabled={sent} sx={{ width: 160 }} />
        </Box>
        {error ? (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <ActionButton variant="contained" startIcon={<ContentCutIcon />} disabled={!!reason} disabledReason={reason} onClick={() => void prepare()}>
            {speech ? 'Обрезать заново' : 'Подготовить WAV'}
          </ActionButton>
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
              Границы по разметке
            </ActionButton>
          ) : null}
        </Stack>
      </Stack>
    </Paper>
  );
}
