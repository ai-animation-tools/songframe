/** Панель рекомендаций по референсам на локальной модели API: агент не запускается, файл не пишется. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { castTexts } from '@shared/texts/cast';
import type { ReferenceAdviceReport, ReferenceAdviceView } from '@shared/scenario-workflow';
import type { AgentJob } from '@shared/agents';
import { storyAccess } from '../testing/commonStories';
import { createStoryApi, type StoryOptions } from '../testing/storybook';
import { ReferenceAdvicePanel } from './ReferenceAdvicePanel';

const PROJECT = '/mock/Клип у старых ворот';
const texts = castTexts.advice;

const REPORT: ReferenceAdviceReport = {
  summary: 'Героиня и ворота с референсами, но без видов со спины; фонарику нужна своя карточка.',
  items: [
    {
      entity: 'vera',
      name: 'Вера',
      need: 'Вид в полный рост со спины и сбоку.',
      views: ['со спины', 'сбоку слева'],
      count: 2,
      states: ['сухая куртка', 'мокрая куртка'],
      why: 'В M03, M07 и M12 Вера уходит от камеры, а изображение одно — спереди; после дождя в M09 куртка мокрая.',
      have: '«Вера — портрет спереди».'
    },
    {
      entity: '',
      name: 'Фонарик',
      need: 'Фонарик крупно, зажжённый и погашенный.',
      views: ['крупно'],
      count: 2,
      states: ['зажжён', 'погашен'],
      why: 'Фонарик крупно в M04 и M10, карточки в кастинге у него нет.',
      have: ''
    }
  ]
};

function job(status: AgentJob['status']): AgentJob {
  return {
    schemaVersion: 1,
    id: 'advice-job-1',
    sequence: 1,
    project: PROJECT,
    provider: 'codex',
    task: 'ai-clip-reference-advice',
    permissions: 'read-only',
    inputHashes: { prompt: 'story-prompt', context: 'story-context' },
    status,
    phase: 'Подготовка рекомендаций',
    startedAt: '2026-11-26T09:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-11-26T09:01:00.000Z',
    exitCode: status === 'completed' ? 0 : null,
    result: '',
    log: ''
  };
}

function view(overrides: Partial<ReferenceAdviceView> = {}): ReferenceAdviceView {
  return { status: 'none', canStart: true, reason: null, preliminary: false, stale: false, report: null, message: null, job: null, ...overrides };
}

/** Сохранения файла в последней истории: play проверяет, что кнопка вызвала диалог сохранения. */
let saves = 0;

/** Модель: запуск переводит совет в «готовится», следующий опрос отдаёт готовый ответ. */
function adviceOptions(initial: ReferenceAdviceView): StoryOptions {
  return {
    app: { online: true, agentProvider: 'codex', aiAccess: storyAccess },
    createApi: () => {
      let current = initial;
      saves = 0;
      return createStoryApi({
        scenarioWorkflow: {
          adviceView: async () => {
            const shown = current;
            if (current.status === 'running') current = view({ status: 'ready', report: REPORT, job: job('completed') });
            return shown;
          },
          startAdvice: async () => {
            current = view({ status: 'running', canStart: false, reason: 'Дождитесь окончания задания агента в этом проекте.', job: job('running') });
            return current;
          },
          saveAdvice: async () => {
            saves++;
            return '/home/user/Рекомендации по референсам.md';
          }
        }
      });
    }
  };
}

const meta = {
  title: 'Кастинг/Рекомендации по референсам',
  component: ReferenceAdvicePanel,
  tags: ['!autodocs'],
  args: { project: PROJECT, defaultExpanded: true },
  parameters: { songframe: adviceOptions(view()) }
} satisfies Meta<typeof ReferenceAdvicePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {
  name: 'Запуск · совет готовится и приходит по сущностям',
  tags: ['!autodocs', 'ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(texts.statusNone)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: texts.start }));
    await expect(await canvas.findByText(REPORT.summary, {}, { timeout: 4000 })).toBeVisible();
    await expect(canvas.getByText(texts.statusReady({ count: 2 }))).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Фонарик' })).toBeVisible();
    await expect(canvas.getByText(texts.newEntity)).toBeVisible();
    await expect(canvas.getByText('мокрая куртка')).toBeVisible();
    await expect(canvas.getByRole('button', { name: texts.restart })).toBeEnabled();
  }
};

export const Ready: Story = {
  name: 'Готовый совет · сохранить в файл',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: adviceOptions(view({ status: 'ready', report: REPORT, job: job('completed') })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: texts.save }));
    await waitFor(() => expect(saves).toBe(1));
  }
};

export const Preliminary: Story = {
  name: 'Без сценария · предварительный совет',
  parameters: { songframe: adviceOptions(view({ status: 'ready', preliminary: true, report: { ...REPORT, summary: `Предварительно: ${REPORT.summary}` } })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(texts.preliminary)).toBeVisible();
    await expect(canvas.getByText(texts.preliminaryHint)).toBeVisible();
  }
};

export const Stale: Story = {
  name: 'Совет устарел · кастинг изменился',
  parameters: { songframe: adviceOptions(view({ status: 'ready', stale: true, report: REPORT })) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(texts.stale)).toBeVisible();
  }
};

export const Invalid: Story = {
  name: 'Ответ агента отклонён · причина и повтор',
  parameters: {
    songframe: adviceOptions(
      view({ status: 'invalid', message: 'Пункт 1 рекомендаций агента не принят: неизвестная сущность ghost. Запустите их снова.', job: job('completed') })
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/неизвестная сущность ghost/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: texts.save })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: texts.restart })).toBeEnabled();
  }
};

export const NoInputs: Story = {
  name: 'Нет идеи и текста · запуск недоступен с причиной',
  parameters: {
    songframe: adviceOptions(
      view({ canStart: false, reason: 'Для рекомендаций нужны идея клипа и текст песни на странице «Исходники» или сценарий.', preliminary: true })
    )
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('button', { name: texts.start })).toBeDisabled();
  }
};
