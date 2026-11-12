/**
 * Просмотр опор под музыку: подряд идущие планы собираются заданием animatic.fragment
 * (build_animatic --from --to) из принятых видео, утверждённых опор или карточек под их участок
 * песни. Это рабочий просмотр: генерации, приёмка, latest и принятие аниматика не меняются, файл
 * фрагмента каждая сборка заменяет. Задание продолжает выполняться и при закрытом диалоге; его
 * состояние и результат живут, пока открыта страница.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Alert, Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { productionTexts } from '@shared/texts/production';
import type { JobInfo, ShotProduction } from '@shared/types';
import { useApp } from '../../../state';
import { formatClock, joinPath } from '../../../format';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { JobStatus } from '../../../components/JobStatus';
import { VideoPlayer } from './VideoPlayer';

const texts = productionTexts.fragmentPreview;

/** Путь фрагмента в проекте; совпадает с buildanimatic.FragmentFile. */
export function fragmentVideoPath(project: string): string {
  return joinPath(project, 'plan', 'animatic', '.cache', 'fragment', 'fragment.mp4');
}

/** Интервал опроса задания фрагмента. */
const POLL_MS = 1000;

export function FragmentPreviewDialog({
  open,
  project,
  shots,
  initialShot,
  onClose
}: {
  open: boolean;
  project: string;
  shots: ShotProduction[];
  /** План, выбранный на странице: диапазон по умолчанию начинается и заканчивается им. */
  initialShot: string | null;
  onClose(): void;
}): ReactElement {
  const { describeError } = useApp();
  const ids = useMemo(() => shots.map((shot) => shot.id), [shots]);
  const [from, setFrom] = useState(initialShot ?? ids[0] ?? '');
  const [to, setTo] = useState(initialShot ?? ids[0] ?? '');
  const [job, setJob] = useState<JobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Открытие диалога предлагает выбранный план, пока не идёт сборка.
  useEffect(() => {
    if (!open || job?.status === 'running' || !initialShot) return;
    setFrom(initialShot);
    setTo(initialShot);
    // Только при открытии: смена плана на странице во время показа не сбрасывает выбор.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Задание опрашивается до завершения; размонтирование страницы останавливает опрос.
  const jobId = job?.status === 'running' ? job.id : null;
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const timer = setInterval(() => {
      void window.api.jobs
        .get(jobId)
        .then((next) => {
          if (active && next) setJob(next);
        })
        .catch((reason: unknown) => {
          if (active) setError(describeError(reason));
        });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [jobId, describeError]);

  const running = starting || job?.status === 'running';
  const fromIndex = ids.indexOf(from);
  const toIndex = ids.indexOf(to);
  const selected = fromIndex >= 0 && toIndex >= fromIndex ? shots.slice(fromIndex, toIndex + 1) : [];
  // Первый план позже последнего двигает другую границу: диапазон всегда остаётся непустым.
  const chooseFrom = (value: string): void => {
    setFrom(value);
    if (ids.indexOf(value) > ids.indexOf(to)) setTo(value);
  };
  const chooseTo = (value: string): void => {
    setTo(value);
    if (ids.indexOf(value) < ids.indexOf(from)) setFrom(value);
  };
  const build = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      setJob(await window.api.animatic.fragment(project, from, to));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setStarting(false);
    }
  };
  const done = job?.status === 'done';

  return (
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title={texts.title}
      description={texts.description}
      cancelLabel={texts.close}
      onConfirm={() => void build()}
      confirmLabel={done ? texts.rebuild : texts.build}
      confirmIcon={<PlayCircleOutlineIcon />}
      confirmDisabled={running || !selected.length}
      confirmDisabledReason={running ? texts.runningReason : null}
    >
      <Stack spacing={2} sx={{ mt: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
          <TextField select size="small" label={texts.from} value={from} disabled={running} onChange={(event) => chooseFrom(event.target.value)}>
            {shots.map((shot) => (
              <MenuItem key={shot.id} value={shot.id}>
                {shot.id} · {shot.title}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label={texts.to} value={to} disabled={running} onChange={(event) => chooseTo(event.target.value)}>
            {shots.map((shot) => (
              <MenuItem key={shot.id} value={shot.id}>
                {shot.id} · {shot.title}
              </MenuItem>
            ))}
          </TextField>
        </Box>
        {selected.length ? (
          <Typography variant="body2" color="text.secondary">
            {texts.window({ start: formatClock(selected[0].start), end: formatClock(selected[selected.length - 1].end) })}
          </Typography>
        ) : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {running ? <JobStatus running label={texts.running} /> : null}
        {job && job.status !== 'running' && job.status !== 'done' ? <JobStatus job={job} /> : null}
        {done ? (
          <Stack spacing={1}>
            <Alert severity="success">{texts.ready}</Alert>
            {/* Тот же плеер, что у результата плана; адрес меняется с каждой сборкой, чтобы не показать прежний файл. */}
            <VideoPlayer path={fragmentVideoPath(project)} version={job.id} label={texts.video} />
          </Stack>
        ) : null}
      </Stack>
    </ConfirmationDialog>
  );
}
