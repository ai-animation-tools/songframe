/** Управляемые родители опор повторяют решения приложения, не вызывая IPC или генератор. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { KeyframeNoteScope, PackageView } from '@shared/types';
import { ActionButton } from '../components/ActionButton';
import { PackageKeyframes } from '../pages/ProductionPage/components/PackageKeyframes';
import { PackageDecision } from '../pages/ProductionPage/components/PackageDecision';
import { STORY_IMAGE_PATH } from './storybook';

const FIXED_DATE = '2026-10-30T09:00:00.000Z';
export const KEYFRAME_STORY_NOTE = 'Сохранить куртку и направление света из утверждённой K01.';

export function keyframeQuestion(frame: string, revision = 0): NonNullable<PackageView['pendingDecision']> {
  return {
    stage: 'keyframes_review',
    frame,
    question: `Утвердить опору ${frame}?`,
    options: ['approve', 'revise'],
    asked_at: new Date(Date.parse(FIXED_DATE) + revision * 1000).toISOString()
  };
}

/** Уникальные пути указывают на одну тестовую картинку: галерея различает опоры по пути. */
export function keyframePackage(overrides: Partial<PackageView> = {}): PackageView {
  return {
    dir: '/mock/Клип у старых ворот/plan/batches/M02-attempt-01',
    relative: 'plan/batches/M02-attempt-01',
    shot: 'M02',
    stage: 'keyframes_review',
    stageLabel: 'Опоры на согласовании',
    waitReason: null,
    mode: null,
    retryOf: null,
    batch: null,
    timing: { frames: 150, window_seconds: 5, request_seconds: 5 },
    keyframes: [
      { id: 'K01', role: 'first', time_seconds: 0, imagePath: `${STORY_IMAGE_PATH}?frame=K01`, approved: true },
      { id: 'K02', role: 'middle', time_seconds: 1.5, imagePath: `${STORY_IMAGE_PATH}?frame=K02`, approved: false },
      { id: 'K03', role: 'middle', time_seconds: 3, imagePath: `${STORY_IMAGE_PATH}?frame=K03`, approved: false },
      { id: 'K04', role: 'last', time_seconds: 5, imagePath: null, approved: false }
    ],
    description: null,
    prompt: null,
    request: null,
    pendingDecision: keyframeQuestion('K02'),
    decision: null,
    keyframeNotes: [
      { id: 1, frame: 'K02', note: KEYFRAME_STORY_NOTE, scope: 'following', active: true, at: FIXED_DATE },
      { id: 2, frame: 'K01', note: 'Снятое замечание: прежний цвет ворот больше не требуется.', scope: 'frame', active: false, at: FIXED_DATE }
    ],
    sceneChanged: false,
    preview: [],
    problems: [],
    ...overrides
  };
}

export interface KeyframeReviewStoryProps {
  initialPackage?: PackageView;
  initialNote?: string;
  showFrames?: boolean;
  showDecision?: boolean;
  busy?: boolean;
  busyReason?: string;
  failFirst?: boolean;
  delay?: number;
}

export function KeyframeReviewStory({
  initialPackage,
  initialNote = '',
  showFrames = true,
  showDecision = true,
  busy = false,
  busyReason,
  failFirst = false,
  delay = 500
}: KeyframeReviewStoryProps) {
  const [pkg, setPackage] = useState(() => structuredClone(initialPackage ?? keyframePackage()));
  const [note, setNote] = useState(initialNote);
  const [running, setRunning] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failed = useRef(false);
  const revision = useRef(0);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  // Решение публикуется только после успешного ответа: ошибка оставляет вопрос, кандидата и черновик.
  const run = (apply: (current: PackageView) => PackageView, message: string, clearDraft = false): void => {
    if (busy || timer.current !== null) return;
    setRunning(true);
    setNotice(null);
    timer.current = setTimeout(() => {
      timer.current = null;
      setRunning(false);
      if (failFirst && !failed.current) {
        failed.current = true;
        setNotice({ error: true, text: 'Не удалось сохранить решение. Кандидаты и замечание сохранены: повторите действие.' });
        return;
      }
      setPackage(apply);
      if (clearDraft) setNote('');
      setNotice({ error: false, text: message });
    }, delay);
  };
  const addNote = (current: PackageView, frame: string, value: string, scope: KeyframeNoteScope): PackageView['keyframeNotes'] => [
    ...current.keyframeNotes,
    { id: Math.max(0, ...current.keyframeNotes.map((item) => item.id)) + 1, frame, note: value.trim(), scope, active: true, at: FIXED_DATE }
  ];
  const decide = (verdict: string, scope: KeyframeNoteScope = 'following'): void => {
    const frame = pkg.pendingDecision?.frame;
    if (!frame || !['approve', 'revise'].includes(verdict) || (verdict === 'revise' && !note.trim())) return;
    const questionRevision = ++revision.current;
    run(
      (current) => {
        const keyframes = current.keyframes.map((item) =>
          item.id !== frame ? item : verdict === 'approve' ? { ...item, approved: true } : { ...item, approved: false, imagePath: null }
        );
        const next = verdict === 'approve' ? keyframes.find((item) => !item.approved && item.imagePath) : null;
        return {
          ...current,
          keyframes,
          pendingDecision: next ? keyframeQuestion(next.id, questionRevision) : null,
          decision: next ? null : { stage: 'keyframes_review', verdict, note: verdict === 'revise' ? note.trim() : undefined, at: FIXED_DATE },
          keyframeNotes: verdict === 'revise' ? addNote(current, frame, note, scope) : current.keyframeNotes
        };
      },
      verdict === 'approve' ? `Утверждена только ${frame}.` : `Кандидат ${frame} снят; замечание сохранено. Новая генерация не запускалась.`,
      true
    );
  };
  const reopen = (frame: string, value: string, scope: KeyframeNoteScope): void => {
    const questionRevision = ++revision.current;
    run((current) => {
      const keyframes = current.keyframes.map((item) => (item.id === frame ? { ...item, approved: false, imagePath: null } : item));
      // Production.reopenFrame после возврата вызывает askNextFrame для оставшегося готового кандидата.
      const next = keyframes.find((item) => item.imagePath && !item.approved);
      return {
        ...current,
        stage: 'keyframes_review',
        stageLabel: 'Опоры на согласовании',
        keyframes,
        pendingDecision: next ? keyframeQuestion(next.id, questionRevision) : null,
        decision: next ? null : { stage: 'keyframes_review', verdict: 'revise', note: value.trim(), at: FIXED_DATE },
        prompt: current.prompt ? { ...current.prompt, approved: false } : null,
        keyframeNotes: addNote(current, frame, value, scope)
      };
    }, `Утверждение ${frame} снято; замечание сохранено. Остальные опоры сохранены.`);
  };
  const locked = busy || running;
  const candidateReason = locked
    ? (busyReason ?? 'Дождитесь сохранения решения.')
    : pkg.pendingDecision
      ? 'Сначала ответьте на текущий вопрос об опоре.'
      : !['keyframes_review', 'prompt_review', 'image_request_choice', 'needs_revision'].includes(pkg.stage)
        ? 'Сначала завершите текущую отправку и получение изображения.'
        : pkg.prompt?.approved || (pkg.request && pkg.request.kind !== 'image')
          ? 'Для изменённой опоры нужна новая попытка.'
          : !pkg.keyframes.some((item) => !item.approved && !item.imagePath)
            ? 'В пакете нет недостающих кандидатов.'
            : null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="caption" color="text.secondary">
          Локальная модель: решения меняют только эту историю. Кандидат, утверждение опоры и приёмка видео — отдельные действия.
        </Typography>
        {showFrames && (
          <PackageKeyframes
            key={`frames:${resetEpoch}`}
            pkg={pkg}
            busy={locked}
            busyReason={busyReason}
            onReopen={reopen}
            onSetNote={(id, active) =>
              run(
                (current) => ({ ...current, keyframeNotes: current.keyframeNotes.map((item) => (item.id === id ? { ...item, active } : item)) }),
                'Замечание снято и больше не учитывается.'
              )
            }
          />
        )}
        {showDecision && (
          <PackageDecision
            key={`decision:${resetEpoch}`}
            pending={pkg.pendingDecision}
            aiKind="image"
            note={note}
            setNote={setNote}
            busy={locked}
            busyReason={busyReason}
            onDecide={decide}
          />
        )}
        {running && (
          <Alert severity="info" role="status">
            Сохраняем решение в локальную модель…
          </Alert>
        )}
        {notice && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
        {!pkg.pendingDecision && <Alert severity="info">Нет открытого вопроса. Следующий кандидат требует отдельной подготовки и согласования.</Alert>}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <ActionButton
            disabled={!!candidateReason}
            disabledReason={candidateReason}
            onClick={() => {
              // Подстановка представляет результат отдельной подготовки/импорта, а не автоматический запуск сервиса.
              const frame = pkg.keyframes.find((item) => !item.approved && !item.imagePath);
              if (!frame) return;
              const candidateRevision = ++revision.current;
              setPackage((current) => ({
                ...current,
                keyframes: current.keyframes.map((item) =>
                  item.id === frame.id ? { ...item, imagePath: `${STORY_IMAGE_PATH}?frame=${frame.id}&revision=${candidateRevision}` } : item
                ),
                pendingDecision: keyframeQuestion(frame.id, candidateRevision),
                decision: null
              }));
              setNote('');
              setNotice(null);
            }}
          >
            Подставить готового кандидата
          </ActionButton>
          <ActionButton
            disabled={locked}
            disabledReason={busyReason ?? 'Дождитесь сохранения решения.'}
            onClick={() => {
              setPackage(structuredClone(initialPackage ?? keyframePackage()));
              // Полный сброс восстанавливает также охват замечания и состояние галереи/диалога в дочерних компонентах.
              setResetEpoch((current) => current + 1);
              setNote(initialNote);
              setNotice(null);
              failed.current = false;
            }}
          >
            Сбросить модель
          </ActionButton>
        </Stack>
      </Stack>
    </Paper>
  );
}
