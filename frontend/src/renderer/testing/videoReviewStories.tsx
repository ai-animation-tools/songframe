/** Локальная модель хранит отчёт между открытиями; файлы и исполнитель принадлежат только витрине. */
import { useState, useSyncExternalStore } from 'react';
import type { Api } from '@shared/api';
import { Button, Stack, Typography } from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import type { VideoReviewView } from '@shared/video-review';
import { videoReviewTexts } from '@shared/texts/video-review';
import { PackageResult } from '../pages/ProductionPage/components/PackageResult';
import { createStoryApi, type StoryOptions } from './storybook';
import { receivedPackage } from './resultStories';
import { storyAccess } from './commonStories';

export const VIDEO_REVIEW_ERROR = 'Не удалось запустить проверку. Исходное видео и прежний отчёт сохранены.';
const pkg = receivedPackage('video', { previews: true });
const project = '/mock/video-review-project';
const reviewCalls = new WeakMap<Api, { snapshot(): { start: number; cancel: number }; subscribe(listener: () => void): () => void }>();

export function reviewView(status: VideoReviewView['status'] = 'completed'): VideoReviewView {
  return {
    status,
    job: null,
    canStart: !['running', 'preparing'].includes(status),
    reason: null,
    error: status === 'failed' ? VIDEO_REVIEW_ERROR : null,
    stale: false,
    durationSeconds: 8,
    frames: [
      { id: 'F001', timeSeconds: 0, path: '/mock/story-image.png?frame=1' },
      { id: 'F002', timeSeconds: 2.5, path: '/mock/story-image.png?frame=2' },
      { id: 'F003', timeSeconds: 6, path: '/mock/story-image.png?frame=3' }
    ],
    report:
      status === 'completed'
        ? {
            schemaVersion: 1,
            summary: 'Персонаж и автомобиль узнаваемы. На втором плане заметно расхождение с опорой.',
            findings: [
              { verdict: 'match', timeSeconds: 0, description: 'Одежда персонажа и цвет автомобиля соответствуют утверждённой опоре.', frameIds: ['F001'] },
              {
                verdict: 'mismatch',
                timeSeconds: 2.5,
                description: 'В середине ролика у автомобиля появляется дополнительная боковая дверь.',
                frameIds: ['F002']
              },
              {
                verdict: 'uncertain',
                timeSeconds: 6,
                description: 'За поднятой пылью не удаётся надёжно оценить положение заднего колеса.',
                frameIds: ['F003']
              }
            ],
            limitations: [
              'Проверка выполнена по отдельным кадрам и не подтверждает непрерывность движения между ними.',
              'Синхронизация губ и звук не оценивались.'
            ]
          }
        : null
  };
}

export function videoReviewStoryOptions(
  options: {
    status?: VideoReviewView['status'];
    stale?: boolean;
    failFirst?: boolean;
    failRead?: boolean;
    longReport?: boolean;
    initiallyBusy?: boolean;
    slowRefresh?: boolean;
  } = {}
): StoryOptions {
  return {
    app: {
      state: { packaged: false, problems: [], toolsRoot: '/mock/tools', localDir: '/mock/state', current: project, history: [], platform: 'linux' },
      agentProvider: 'codex',
      aiAccess: storyAccess
    },
    createApi: () => {
      let view: VideoReviewView = { ...reviewView(options.status ?? 'idle'), stale: !!options.stale };
      if (options.longReport && view.report) {
        view.report.findings.push(
          ...Array.from({ length: 6 }, (_, index) => ({
            verdict: 'uncertain' as const,
            timeSeconds: 6.5,
            description: `Дополнительное наблюдение ${index + 4}.`,
            frameIds: ['F003']
          }))
        );
      }
      let calls = { start: 0, cancel: 0 };
      const listeners = new Set<() => void>();
      const count = (operation: 'start' | 'cancel'): void => {
        calls = { ...calls, [operation]: calls[operation] + 1 };
        for (const listener of listeners) listener();
      };
      let reads = 0;
      let failed = false;
      let readFailed = false;
      let busyRead = !!options.initiallyBusy;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const checked = (nextProject: string, dir: string): void => {
        if (nextProject !== project || dir !== pkg.dir) throw new Error('Запрошен другой пакет проверки.');
      };
      const session = createStoryApi({
        videoReview: {
          view: async (nextProject, dir) => {
            checked(nextProject, dir);
            reads++;
            if (options.slowRefresh && reads > 1)
              await new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  timer = null;
                  resolve();
                }, 350);
              });
            if (options.failRead && !readFailed) {
              readFailed = true;
              throw new Error('Не удалось прочитать сохранённый отчёт.');
            }
            if (busyRead) {
              busyRead = false;
              return { ...structuredClone(view), canStart: false, reason: videoReviewTexts.main.busy };
            }
            return structuredClone(view);
          },
          start: async (nextProject, dir) => {
            checked(nextProject, dir);
            count('start');
            if (options.failFirst && !failed) {
              failed = true;
              throw new Error(VIDEO_REVIEW_ERROR);
            }
            view = { ...view, status: 'preparing', canStart: false, reason: videoReviewTexts.runningReason, error: null };
            timer = setTimeout(() => {
              timer = null;
              view = reviewView();
            }, 250);
            return structuredClone(view);
          },
          cancel: async (nextProject, dir) => {
            checked(nextProject, dir);
            count('cancel');
            if (timer !== null) clearTimeout(timer);
            timer = null;
            view = { ...view, status: 'cancelled', canStart: true, reason: null, error: null };
            return structuredClone(view);
          }
        }
      });
      reviewCalls.set(session.api, {
        snapshot: () => calls,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      });
      session.onCleanup(() => {
        reviewCalls.delete(session.api);
        listeners.clear();
        if (timer !== null) clearTimeout(timer);
      });
      return session;
    }
  };
}

export function VideoReviewStory({ accepted = false }: { accepted?: boolean }) {
  const model = reviewCalls.get(window.api);
  if (!model) throw new Error('История требует videoReviewStoryOptions.');
  const calls = useSyncExternalStore(model.subscribe, model.snapshot);
  const [open, setOpen] = useState(true);
  const [acceptedCount, setAccepted] = useState(0);
  return (
    <Stack spacing={2}>
      {open && (
        <PackageResult
          pkg={accepted ? { ...pkg, stage: 'accepted', stageLabel: 'Принят' } : pkg}
          busy={false}
          onAccept={() => setAccepted((count) => count + 1)}
          onSelectImage={() => undefined}
          onContactSheet={() => undefined}
        />
      )}
      <Typography data-testid="review-agent-calls">
        Запусков агента: {calls.start}; отмен: {calls.cancel}
      </Typography>
      <Typography data-testid="review-accepts">Подтверждений приёмки: {acceptedCount}</Typography>
      <Button startIcon={<VisibilityOutlinedIcon />} onClick={() => setOpen((value) => !value)} sx={{ alignSelf: 'start' }}>
        {open ? 'Закрыть результат' : 'Открыть результат'}
      </Button>
    </Stack>
  );
}
