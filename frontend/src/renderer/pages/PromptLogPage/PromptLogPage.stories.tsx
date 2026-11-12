/** Настоящая страница «Отправки» на локальной модели журнала: фильтры, раскрытие записи и переход к месту в проекте. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { promptLogTexts as texts } from '@shared/texts/prompt-log';
import { navigationTexts } from '@shared/texts/navigation';
import type { PromptLogRecord, PromptLogSummary } from '@shared/types';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { createStoryApi, type StoryOptions } from '../../testing/storybook';
import { PromptLogPage } from './PromptLogPage';

const PROJECT = '/mock/Клип у старых ворот';

/** Полная запись по краткой строке: промпт, контекст и ответ задаются явно. */
function record(summary: PromptLogSummary, extra: Partial<PromptLogRecord> = {}): PromptLogRecord {
  return {
    id: summary.id,
    kind: summary.kind,
    title: summary.title,
    executor: summary.executor,
    model: summary.model,
    place: summary.place,
    started_at: summary.startedAt,
    finished_at: summary.finishedAt,
    status: summary.status,
    prompt: '',
    context: '',
    attachments: [],
    response: '',
    error: summary.error,
    paid: null,
    truncated: false,
    ...extra
  };
}

const SCENE: PromptLogSummary = {
  id: 'agent-1',
  kind: 'agent',
  title: 'ai-clip-scene:M02:description',
  executor: 'codex',
  model: '',
  place: { page: 'production', shot: 'M02' },
  startedAt: '2026-11-12T10:05:00.000Z',
  finishedAt: '2026-11-12T10:06:10.000Z',
  status: 'completed',
  error: '',
  paid: false
};
const VIDEO: PromptLogSummary = {
  id: 'paid-1',
  kind: 'video',
  title: 'M02 · Запрос видео',
  executor: 'test',
  model: 'test-video',
  place: { page: 'production', shot: 'M02' },
  startedAt: '2026-11-12T10:20:00.000Z',
  finishedAt: '2026-11-12T10:20:04.000Z',
  status: 'failed',
  error: 'Сервис отклонил запрос до оплаты: недопустимая длительность.',
  paid: true
};
const SCENARIO: PromptLogSummary = {
  id: 'agent-2',
  kind: 'agent',
  title: 'ai-clip-scenario:treatment',
  executor: 'claude',
  model: '',
  place: { page: 'scenario' },
  startedAt: '2026-11-12T09:00:00.000Z',
  finishedAt: null,
  status: 'interrupted',
  error: '',
  paid: false
};
const ENTRIES = [VIDEO, SCENE, SCENARIO];
const RECORDS: Record<string, PromptLogRecord> = {
  [SCENE.id]: record(SCENE, {
    prompt: 'Задача:\nОпиши события плана M02 по порядку.',
    context: '{"shot":"M02"}',
    attachments: [{ path: 'source/pier.png', sha256: 'a'.repeat(64) }],
    response: '{"description":"Герой останавливается у ворот."}'
  }),
  [VIDEO.id]: record(VIDEO, {
    prompt: 'Камера медленно приближается к старым воротам.',
    context: '{"duration":5}',
    paid: { request_sha256: 'b'.repeat(64), generation_id: null, amount: null, unit: null },
    response: '{\n  "status": "prepared"\n}'
  }),
  [SCENARIO.id]: record(SCENARIO, { prompt: 'Задача:\nТрактовка песни.' })
};

function options(entries: PromptLogSummary[]): StoryOptions {
  return {
    shell: 'page',
    route: '/project/prompts',
    app: { state: { packaged: false, problems: [], localDir: '/mock/state', current: PROJECT, history: [], platform: 'linux' } },
    createApi: () => {
      const session = createStoryApi({
        promptLog: {
          list: async () => structuredClone(entries),
          get: async (_project, id) => structuredClone(RECORDS[id] ?? null)
        }
      });
      // Сервис платной записи называется по реестру провайдеров, как в приложении.
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      return session;
    }
  };
}

const meta = {
  title: 'Страницы/Отправки',
  component: PromptLogPage,
  tags: ['!autodocs'],
  parameters: { songframe: options(ENTRIES), controls: { disable: true } }
} satisfies Meta<typeof PromptLogPage>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = (canvasElement: HTMLElement) => within(canvasElement.ownerDocument.body);

export const Journal: Story = {
  name: 'Журнал · фильтры, полная запись и переход к плану',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = body(canvasElement);
    await screen.findByText(texts.count({ shown: 3, total: 3 }));
    // Прерванная отправка прошлого запуска видна с заметным итогом.
    await expect(screen.getByText(texts.statuses.interrupted)).toBeInTheDocument();
    // Служебные имена заданий показаны словами страницы, сервис — по реестру.
    await expect(screen.getByText('M02 · Описание')).toBeInTheDocument();
    await expect(screen.getByText('Сценарий · трактовка')).toBeInTheDocument();
    await expect(screen.getByText(new RegExp(testProviderInfo.title))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: texts.statusFilter }));
    await userEvent.click(await screen.findByRole('option', { name: texts.statuses.failed }));
    await screen.findByText(texts.count({ shown: 1, total: 3 }));
    await userEvent.click(screen.getByText(VIDEO.title));
    await screen.findByText(`${texts.error}: ${VIDEO.error}`);
    await expect(screen.getByRole('region', { name: texts.parameters })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: texts.statusFilter }));
    await userEvent.click(await screen.findByRole('option', { name: texts.all }));
    await userEvent.click(screen.getByText(texts.title(SCENE.title)));
    const prompts = await screen.findAllByRole('region', { name: texts.prompt });
    await waitFor(() => expect(prompts.some((item) => item.textContent?.includes('Опиши события плана M02'))).toBe(true));
    await expect(screen.getByText('source/pier.png', { exact: false })).toBeInTheDocument();
    const link = screen.getAllByRole('link', { name: texts.openShot({ page: navigationTexts.pages.production, shot: 'M02' }) })[0];
    await userEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('story-route')).toHaveTextContent('/project/production?shot=M02'));
  }
};

export const Empty: Story = {
  name: 'Отправок нет · пояснение',
  tags: ['ci'],
  parameters: { songframe: options([]) },
  play: async ({ canvasElement }) => {
    await body(canvasElement).findByText(texts.empty);
  }
};

export const Expanded: Story = {
  name: 'Раскрытая запись агента · промпт, контекст, вложения и ответ',
  play: async ({ canvasElement }) => {
    const screen = body(canvasElement);
    await userEvent.click(await screen.findByText(texts.title(SCENE.title)));
    await screen.findByRole('region', { name: texts.response });
    await expect(screen.getByRole('region', { name: texts.context })).toHaveTextContent('{"shot":"M02"}');
  }
};
