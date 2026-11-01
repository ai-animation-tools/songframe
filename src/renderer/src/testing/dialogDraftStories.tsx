/** Черновики окон и их настоящие страницы используют только локальные данные и методы API витрины. */
import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/material';
import type { AgentJob } from '@shared/agents';
import type { ProjectStatus } from '@shared/types';
import { AgentRetryDialog } from '../components/AgentRetryDialog';
import { ProjectRenameDialog } from '../pages/ProjectPage/components/ProjectRenameDialog';
import { storyAccess } from './commonStories';
import type { StoryOptions } from './storybook';

export const DRAFT_PROJECT = '/mock/dialog-draft';
export const DRAFT_NAME = 'Клип у ворот';
export const retryJob: AgentJob = {
  schemaVersion: 1,
  id: 'retry-draft',
  sequence: 1,
  project: DRAFT_PROJECT,
  provider: 'codex',
  task: 'Подготовка предложения',
  permissions: 'read-only',
  inputHashes: { prompt: 'draft-prompt', context: 'draft-context' },
  status: 'failed',
  phase: 'Завершено',
  startedAt: '2026-11-01T09:00:00.000Z',
  finishedAt: '2026-11-01T09:01:00.000Z',
  exitCode: 1,
  result: '',
  log: ''
};
const projectStatus: ProjectStatus = {
  path: DRAFT_PROJECT,
  name: DRAFT_NAME,
  state: 'empty',
  animaticVideo: null,
  problems: [],
  checks: {
    marker: true,
    sources: false,
    timing: false,
    cast: false,
    treatment: false,
    scenes: false,
    shotsTotal: 0,
    shotsDone: 0,
    animaticBuilt: false,
    animaticFresh: false,
    animaticApproved: false
  }
};
export function draftDialogOptions(page = false): StoryOptions {
  return {
    ...(page ? { shell: 'page' as const } : {}),
    app: {
      aiAccess: storyAccess,
      agentProvider: 'codex',
      status: projectStatus,
      state: { packaged: false, problems: [], toolsRoot: '/mock/songframe', localDir: '/mock/state', current: DRAFT_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => ({
      agents: {
        list: async () => [structuredClone(retryJob)],
        start: async () => {
          throw new Error('Не удалось запустить задание. Черновик сохранён.');
        }
      },
      jobs: { list: async () => [] },
      environment: { check: async () => [] },
      projects: {
        settings: async () => ({ name: DRAFT_NAME, animaticVideo: 'animatic.mp4', generation: null }),
        rename: async () => {
          throw new Error('Не удалось сохранить название. Черновик сохранён.');
        }
      }
    })
  };
}
export function DraftDialogStory({ kind }: { kind: 'rename' | 'retry' }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack spacing={2}>
      <Button onClick={() => setOpen(true)}>Открыть редактор</Button>
      <Typography>Сохранённое название: {DRAFT_NAME}</Typography>
      {open &&
        (kind === 'rename' ? (
          <ProjectRenameDialog project={DRAFT_PROJECT} name={DRAFT_NAME} onClose={() => setOpen(false)} />
        ) : (
          <AgentRetryDialog job={retryJob} onClose={() => setOpen(false)} />
        ))}
    </Stack>
  );
}
