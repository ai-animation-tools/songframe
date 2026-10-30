/** Карточка сохраняет доступ к принятому видео и различает подготовку новой попытки и её отправку. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ProductionShotStory, productionShot, preparedPackage, queuedPackage, RETRY_ERROR } from '../../../testing/productionQueueStories';
import { STORY_VIDEO_PATH } from '../../../testing/storybook';
import { BUSY_REASON, PYTHON_REASON } from '../constants';
import { productionTexts } from '@shared/texts/production';

const meta = {
  title: 'Производство/Планы/Карточка плана',
  component: ProductionShotStory,
  // Подтверждение повтора управляет фокусом и выполняется только в отдельном Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ProductionShotStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ProductionShotStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Accepted: Story = { name: 'Принят · монтажное видео и original' };
export const Stale: Story = {
  name: 'Постановка изменена · принятое видео сохранено',
  args: { initialShot: productionShot({ state: 'stale', stageLabel: 'Постановка изменена' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Постановка плана изменилась после приёмки/)).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(2);
    await expect(canvas.queryByRole('button', { name: 'Подготовить повтор' })).not.toBeInTheDocument();
  }
};
export const MissingVideo: Story = {
  name: 'Приёмка сохранена · монтажный файл отсутствует',
  args: { initialShot: productionShot({ asset: { dir: '/mock/assets/shots/M02', video: null, original: STORY_VIDEO_PATH } }) }
};
export const NoMaterial: Story = {
  name: 'План ещё не производился · материала и повтора нет',
  args: {
    initialShot: productionShot({ state: 'planned', stageLabel: 'Запланирован', asset: null, regenerateProblem: 'Нет сохранённого запроса для повтора.' })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Принятые материалы')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Подготовить повтор' })).not.toBeInTheDocument();
  }
};
const waiting = preparedPackage();
export const OpenWaiting: Story = {
  name: 'Открыть пакет · выбранный вопрос больше не дублируется',
  args: { initialShot: productionShot({ packages: [waiting], attention: waiting.pendingDecision!.question }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть пакет' }));
    await expect(canvas.getByText(/Открыт пакет: plan\/batches\/M02-attempt-01/)).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Открыть пакет' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('button', { name: 'Открыть пакет' })).toBeInTheDocument();
  }
};
export const LongLabels: Story = {
  name: 'Длинные название, постановка и вопрос пакета',
  args: {
    initialShot: productionShot({
      title: 'Возвращение героя к старым воротам после долгого пути через посёлок при вечернем свете из окна',
      original:
        'Герой останавливается у закрытых ворот, ставит сумку на землю, замечает свет в окне и медленно переводит взгляд на калитку. Сохранить одежду, повреждение рукава и направление освещения из предыдущего плана.',
      packages: [
        {
          ...waiting,
          pendingDecision: {
            ...waiting.pendingDecision!,
            question: 'Подтвердить подготовленный запрос с сохранением положения персонажа, вечернего света и всех утверждённых опор?'
          }
        }
      ]
    })
  }
};
const unknown = queuedPackage();
export const UnknownSubmission: Story = {
  name: 'Исход прежней отправки неизвестен · повтор запрещён',
  args: {
    initialShot: productionShot({
      packages: [
        {
          ...unknown,
          stage: 'submitted',
          waitReason: null,
          decision: { stage: 'request_choice', verdict: 'send' },
          request: { ...unknown.request!, attemptStatus: 'submission_unknown' }
        }
      ]
    })
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Подготовить повтор' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining(productionTexts.productionShotCard.submissionUnknown));
  }
};
export const NoPython: Story = {
  name: 'Нет Python · принятое видео доступно',
  args: { pythonAvailable: false },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Подготовить повтор' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining(PYTHON_REASON));
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(2);
  }
};
export const Busy: Story = {
  name: 'Операция выполняется · повтор заблокирован',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Подготовить повтор' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining(BUSY_REASON));
  }
};
export const IncompatibleRequest: Story = {
  name: 'Сохранённый запрос несовместим · причина важнее занятости',
  args: { busy: true, initialShot: productionShot({ regenerateProblem: 'В сохранённом комплекте отсутствует снимок запроса. Подготовьте новый пакет.' }) },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Подготовить повтор' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining('В сохранённом комплекте отсутствует снимок запроса.'));
    await expect(button).not.toHaveAttribute('title', expect.stringContaining(BUSY_REASON));
  }
};
export const PrepareRetry: Story = {
  name: 'Повтор · отмена, подтверждение и открытие новой попытки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Подготовить повтор' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Подготовить повтор' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подготовить повтор' }));
    await canvas.findByText(/Подготовка повтора M02: выполнено/);
    await expect(canvas.getByText(/Открыт пакет: plan\/batches\/M02-attempt-01\. Отправок генерации: 0/)).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Подготовка повтора M02: выполнено/)).not.toBeInTheDocument();
  }
};
export const RetryFailure: Story = {
  name: 'Ошибка подготовки · сохранённый комплект и повтор действия',
  args: { failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const repeat = async (): Promise<void> => {
      await userEvent.click(canvas.getByRole('button', { name: 'Подготовить повтор' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Подготовить повтор' }));
    };
    await repeat();
    await canvas.findByText(RETRY_ERROR);
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(2);
    await repeat();
    await canvas.findByText(/Открыт пакет: plan\/batches\/M02-attempt-01/);
    await expect(canvas.queryByText(RETRY_ERROR)).not.toBeInTheDocument();
  }
};
