/** Локальные модели диалогов сценария: показывают последствия решения, не вычисляют отпечатки и не пишут файлы. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Chip, Paper, Snackbar, Stack, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { ScenarioImpactShot, ScenesFile, ScenesSaveMode, ShotProductionState } from '@shared/types';
import { scenarioTexts } from '@shared/texts/scenario';
import { ActionButton } from '../components/ActionButton';
import { SHOT_STATE_LABELS } from '../components/shotState';
import { ScenesSaveDialog } from '../pages/ScenarioPage/components/ScenesSaveDialog';
import { ScenarioDraftConflictDialog } from '../pages/ScenarioPage/components/ScenarioDraftConflictDialog';

export const SCENARIO_SAVE_ERROR = 'Не удалось сохранить сценарий. Черновик и принятые материалы сохранены: повторите действие.';
export const SCENARIO_CONFLICT_ERROR = 'Не удалось сохранить правки. Черновик сохранён, продолжение не выполнено.';
export const SCENARIO_DRAFT = 'Олег осторожно открывает калитку и замечает следы на мокрой дорожке.';
const SAVED_ACTION = 'Олег открывает калитку.';
const WAIT_REASON = scenarioTexts.save.wait;

export function scenarioSaveShots(longList = false, stale = false): ScenarioImpactShot[] {
  return Array.from({ length: longList ? 28 : 3 }, (_, index) => ({
    id: `M${String(index + 1).padStart(2, '0')}`,
    reason:
      index % 3 === 0
        ? 'Изменена собственная постановка плана: действие, камера и положение персонажа у калитки.'
        : index % 3 === 1
          ? 'Изменилось унаследованное состояние из M01: направление взгляда и положение калитки перед следующим действием.'
          : 'Изменился источник производного плана M01: требуется проверить соответствие сохранённого материала новой постановке.',
    state: index === 0 ? (stale ? 'stale' : 'completed') : index === 1 ? 'progress' : 'stale',
    produced: true
  }));
}

function sceneDraft(action: string): ScenesFile {
  return {
    schema_version: 1,
    fps: 30,
    audio: { path: 'source/track.mp3', end_seconds: '00:00:05.000' },
    visual_direction: 'Мягкий вечерний свет у старых ворот.',
    references: {},
    logline: 'Олег возвращается на дачу.',
    sequences: [{ id: 's01', title: 'У ворот', direction: 'Тихое возвращение домой.', start: 0, end: 5, entities: [] }],
    scenes: [
      {
        id: 'M01',
        original: 'Куплет',
        sequence: 's01',
        start_frame: 0,
        end_frame_exclusive: 150,
        camera: 'Средний план',
        action,
        continuity: 'Калитка закрыта.',
        references: [],
        lipsync: false,
        card: { primary_reference: '' },
        state_from: null,
        state_changes: {}
      }
    ]
  };
}

/** Таймер принадлежит экземпляру истории; смена истории и сброс отменяют незавершённую запись. */
function useStoryWrite() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [running, setRunning] = useState(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setRunning(false);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  return {
    running,
    cancel,
    run(callback: () => void, delay: number) {
      if (timer.current !== null) return;
      setRunning(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setRunning(false);
        callback();
      }, delay);
    }
  };
}

function StoryError({ message }: { message: string | null }) {
  // Ошибка родителя видна поверх открытого рабочего диалога, как уведомление приложения.
  return (
    <Snackbar open={!!message}>
      <Alert severity="error">{message}</Alert>
    </Snackbar>
  );
}

export interface ScenesSaveStoryProps {
  mode?: ScenesSaveMode;
  stale?: boolean;
  longList?: boolean;
  busy?: boolean;
  failFirst?: boolean;
  delay?: number;
}

export function ScenesSaveStory({ mode = 'production', stale = false, longList = false, busy = false, failFirst = false, delay = 180 }: ScenesSaveStoryProps) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState(SCENARIO_DRAFT);
  const [saved, setSaved] = useState(SAVED_ACTION);
  const [state, setState] = useState<ShotProductionState>(stale ? 'stale' : 'completed');
  const [packageStale, setPackageStale] = useState(stale);
  const [animaticStale, setAnimaticStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writes, setWrites] = useState(0);
  const [kept, setKept] = useState<string[]>([]);
  const failed = useRef(false);
  const write = useStoryWrite();
  const locked = busy || write.running;
  const shots = scenarioSaveShots(longList, stale);
  const reset = () => {
    write.cancel();
    setDraft(SCENARIO_DRAFT);
    setSaved(SAVED_ACTION);
    setState(stale ? 'stale' : 'completed');
    setPackageStale(stale);
    setAnimaticStale(false);
    setError(null);
    setWrites(0);
    setKept([]);
    failed.current = false;
    setOpen(true);
  };
  // keep — планы, оставленные принятыми в окне обычного сохранения: их комплект и пакет сохраняют силу.
  const save = (keep: string[]) => {
    if (locked) return;
    setError(null);
    write.run(() => {
      if (failFirst && !failed.current) {
        failed.current = true;
        setError(SCENARIO_SAVE_ERROR);
        return;
      }
      // Это ожидаемый снимок UI; настоящие отпечатки, транзакции и производные связи проверяет Go.
      setSaved(draft);
      setAnimaticStale(true);
      setWrites((value) => value + 1);
      setKept(keep);
      if (mode === 'production') {
        if (!keep.includes('M01')) setState('stale');
        if (!keep.includes('M02')) setPackageStale(true);
      }
      setOpen(false);
    }, delay);
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="caption" color="text.secondary">
          Модель последствий сохранения. Набор затронутых планов задан заранее; файловые расчёты, вызовы Go и производство не выполняются.
        </Typography>
        <TextField
          label="Черновик постановки"
          multiline
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          slotProps={{ input: { readOnly: locked } }}
        />
        <Typography data-testid="saved-scenes">Сохранённая постановка: {saved}</Typography>
        <Typography data-testid="save-count">Успешных сохранений: {writes}</Typography>
        <Typography data-testid="kept">Оставлены принятыми: {kept.join(', ') || 'нет'}.</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography>Принятый M01:</Typography>
          <Chip label={SHOT_STATE_LABELS[state].label} color={SHOT_STATE_LABELS[state].color} />
        </Stack>
        <Typography data-testid="package-state">
          Пакет M02: {packageStale ? 'постановка изменена, требуется новое согласование' : 'прежнее согласование сохраняется'}.
        </Typography>
        <Typography data-testid="old-stale">Ранее устаревший M03: постановка изменена; прежнее утверждение не восстановлено.</Typography>
        <Typography data-testid="media-history">Медиа: assets/M01.mp4, source/M01-original.mp4. История: 3 попытки. Сохранены.</Typography>
        <Alert severity={animaticStale ? 'warning' : 'info'} data-testid="animatic-state">
          Аниматик: {animaticStale ? 'устарел, требуется локальная пересборка' : 'соответствует сохранённому сценарию'}.
        </Alert>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <ActionButton
            startIcon={<SaveIcon />}
            disabled={locked}
            disabledReason={WAIT_REASON}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            Открыть подтверждение сохранения
          </ActionButton>
          <ActionButton startIcon={<RefreshIcon />} onClick={reset}>
            Сбросить модель
          </ActionButton>
        </Stack>
        <ScenesSaveDialog
          request={open ? { mode, scenes: sceneDraft(draft), shots } : null}
          busy={locked}
          onConfirm={save}
          onClose={() => {
            if (!locked) setOpen(false);
          }}
        />
        <StoryError message={error} />
      </Stack>
    </Paper>
  );
}

export interface ScenarioDraftConflictStoryProps {
  busy?: boolean;
  failFirst?: boolean;
  delay?: number;
}

export function ScenarioDraftConflictStory({ busy = false, failFirst = false, delay = 180 }: ScenarioDraftConflictStoryProps) {
  const [open, setOpen] = useState(true);
  const [scenes, setScenes] = useState(SCENARIO_DRAFT);
  const [savedScenes, setSavedScenes] = useState(SAVED_ACTION);
  const [continued, setContinued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const failed = useRef(false);
  const write = useStoryWrite();
  const locked = busy || write.running;
  const dirtyScenes = scenes !== savedScenes;
  const resolve = (action: 'save' | 'discard') => {
    if (locked) return;
    setError(null);
    if (action === 'discard') {
      setScenes(savedScenes);
      setOpen(false);
      setContinued((value) => value + 1);
      return;
    }
    write.run(() => {
      if (failFirst && !failed.current) {
        failed.current = true;
        setError(SCENARIO_CONFLICT_ERROR);
        return;
      }
      setSavedScenes(scenes);
      setOpen(false);
      setContinued((value) => value + 1);
    }, delay);
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="caption" color="text.secondary">
          Локальное разрешение черновиков. Продолжение только увеличивает счётчик; агент и API не запускаются.
        </Typography>
        <TextField
          label="Черновик сценария"
          multiline
          value={scenes}
          onChange={(event) => setScenes(event.target.value)}
          slotProps={{ input: { readOnly: locked } }}
        />
        <Typography data-testid="saved-scenes">Сохранённый сценарий: {savedScenes}</Typography>
        <Typography data-testid="dirty-state">Несохранённые правки: {dirtyScenes ? 'да' : 'нет'}.</Typography>
        <Typography data-testid="continue-count">Продолжений: {continued}. Запусков агента: 0.</Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <ActionButton
            startIcon={<OpenInNewIcon />}
            disabled={locked || !dirtyScenes}
            disabledReason={locked ? scenarioTexts.drafts.waitSaving : 'Нет несохранённых правок.'}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            Открыть конфликт черновиков
          </ActionButton>
          <ActionButton
            startIcon={<RefreshIcon />}
            onClick={() => {
              write.cancel();
              setScenes(SCENARIO_DRAFT);
              setSavedScenes(SAVED_ACTION);
              setContinued(0);
              setError(null);
              failed.current = false;
              setOpen(true);
            }}
          >
            Сбросить модель
          </ActionButton>
        </Stack>
        <ScenarioDraftConflictDialog
          open={open}
          busy={locked}
          onResolve={resolve}
          onClose={() => {
            if (!locked) setOpen(false);
          }}
        />
        <StoryError message={error} />
      </Stack>
    </Paper>
  );
}
