/** Предложения четырёх этапов и сохранение после явного решения пользователя. */
import { productionTexts } from '@shared/texts/production';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ProductionProposal } from '@shared/production-workflow';
import { ProposalPreviewStory } from '../../../testing/proposalPreviewStories';
import { WORKFLOW_STORY_DESCRIPTION, workflowProposal } from '../../../testing/productionWorkflowStories';

const meta = {
  title: 'Производство/Подготовка/Предложение и сравнение',
  component: ProposalPreviewStory,
  // Подтверждения и галерея переводят фокус: взаимодействия выполняются в отдельном Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ProposalPreviewStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ProposalPreviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Description: Story = {
  name: 'Описание · отмена сохраняет · применение записывает · отклонение убирает',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const saved = canvas.getByTestId('saved-materials');
    await expect(saved).toHaveTextContent('Герой стоит перед воротами.');
    await userEvent.click(canvas.getByRole('button', { name: 'Применить предложение' }));
    let confirmation = body.getByRole('dialog', { name: 'Применить предложение?' });
    await expect(within(confirmation).getByRole('button', { name: 'Отмена' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(saved).toHaveTextContent('Герой стоит перед воротами.');
    await userEvent.click(canvas.getByRole('button', { name: 'Применить предложение' }));
    confirmation = body.getByRole('dialog', { name: 'Применить предложение?' });
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(saved).toHaveTextContent('Герой стоит перед воротами.');
    await userEvent.click(canvas.getByRole('button', { name: 'Применить предложение' }));
    await userEvent.click(within(body.getByRole('dialog', { name: 'Применить предложение?' })).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(saved).toHaveTextContent(WORKFLOW_STORY_DESCRIPTION));
    await expect(canvas.queryByRole('button', { name: 'Применить предложение' })).not.toBeInTheDocument();
    await expect(canvas.getByText('Согласование в этой модели не выполнялось.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Отклонить предложение' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Отклонить предложение' }));
    await userEvent.click(within(body.getByRole('dialog')).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(canvas.getByText('Предложения нет.')).toBeInTheDocument());
    await expect(saved).toHaveTextContent('Герой стоит перед воротами.');
  }
};
export const FirstDescription: Story = {
  name: 'Первое описание · сохранённых материалов ещё нет',
  args: { initialProposal: workflowProposal('description', { before: '' }) }
};
export const Prompt: Story = {
  name: 'Видеопромпт · сравнение текстов',
  args: { initialProposal: workflowProposal('prompt') }
};
export const FirstPrompt: Story = {
  name: 'Первый видеопромпт · пустая левая колонка',
  args: { initialProposal: workflowProposal('prompt', { before: '' }) }
};
export const Request: Story = {
  name: 'Запрос · состояние пакета, входы и параметры',
  args: {
    initialProposal: workflowProposal('request', {
      before: JSON.stringify({
        stage: 'prompt_review',
        request_dir: 'requests/предыдущая-подготовка',
        keyframes: [{ id: 'K01' }, { id: 'K02' }],
        prompt: { approved: true }
      }),
      after: {
        schemaVersion: 1,
        stage: 'request',
        request: {
          model: 'Демонстрационная модель с подробным названием для сравнения запроса',
          command: 'image_to_video',
          parameters: { duration: 8, aspect_ratio: '16:9', camera: { movement: 'Плавное приближение вдоль ворот', keep_identity: true } },
          inputs: [
            { flag: 'image', slot: 'first_frame', path: 'assets/старые ворота/опоры/начало/story-image.png', role: 'first' },
            { flag: 'image', slot: 'last_frame', path: 'assets/старые ворота/опоры/конец/story-image.png', role: 'last' }
          ],
          outputs: 1
        }
      }
    })
  }
};
export const Frames: Story = {
  name: 'Кандидаты опор · галерея, повторное открытие и отдельное согласование',
  args: { initialProposal: workflowProposal('frames') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: K01/ }));
    let gallery = body.getByRole('dialog');
    await expect(within(gallery).getByText('Кандидат опоры · 1 / 2')).toBeInTheDocument();
    await expect(within(gallery).getByRole('button', { name: 'Предыдущее изображение' })).toBeDisabled();
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(gallery).getByText('Кандидат опоры · 2 / 2')).toBeInTheDocument();
    await userEvent.click(within(gallery).getByRole('button', { name: 'Оригинальный размер (1:1)' }));
    await expect(within(gallery).getByRole('button', { name: 'Оригинальный размер (1:1)' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(within(gallery).getByRole('button', { name: 'Оригинальный размер (1:1)' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: K02/ }));
    gallery = body.getByRole('dialog');
    await expect(within(gallery).getByText('Кандидат опоры · 2 / 2')).toBeInTheDocument();
    await expect(within(gallery).getByRole('button', { name: 'Оригинальный размер (1:1)' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(gallery).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Применить предложение' }));
    await userEvent.click(within(body.getByRole('dialog')).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(canvas.getByTestId('saved-materials')).toHaveTextContent('Сохранены кандидаты: K01, K02. Все требуют отдельного утверждения.'));
  }
};
export const Running: Story = {
  name: 'Агент работает · предложение ещё не получено',
  args: { initialProposal: workflowProposal('description', { status: 'running', after: null }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Предложение ещё не получено.')).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Применить предложение' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Отклонить предложение' })).not.toBeInTheDocument();
  }
};
export const ReadyWithoutMaterials: Story = {
  name: 'Готово без материалов · применение заблокировано',
  args: { initialProposal: workflowProposal('description', { after: null }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Отклонить предложение' })).toBeEnabled();
  }
};
export const Stale: Story = {
  name: 'Исходные материалы изменились · предложение устарело',
  args: { initialProposal: workflowProposal('description', { stale: true }) },
  play: ReadyWithoutMaterials.play
};
export const Invalid: Story = {
  name: 'Ответ не прошёл проверку · исходный текст и причина',
  args: {
    initialProposal: workflowProposal('description', {
      status: 'invalid',
      after: null,
      agentText: '{"stage":"description","description":"Герой у ворот","requestSeconds":0}',
      message: 'Длительность должна соответствовать настройкам проекта; план опор отсутствует.'
    })
  },
  play: ReadyWithoutMaterials.play
};
export const Refused: Story = {
  name: 'Штатный отказ агента · противоречие в постановке',
  args: {
    initialProposal: workflowProposal('description', {
      status: 'invalid',
      after: null,
      refused: true,
      agentText: 'В постановке герой одновременно находится внутри машины и у ворот. Уточните его положение перед подготовкой.',
      message: 'Агент отказался готовить предложение.'
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Причина отказа')).toBeInTheDocument();
    await expect(canvas.queryByText('Причина проверки')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeDisabled();
  }
};
export const Failed: Story = {
  name: 'Задание завершилось ошибкой · прежние материалы сохранены',
  args: {
    initialProposal: workflowProposal('prompt', { status: 'failed', after: null, message: 'Агент завершился с ошибкой. Сохранённый видеопромпт не изменён.' })
  },
  play: ReadyWithoutMaterials.play
};
export const Interrupted: Story = {
  name: 'Задание прервано · можно отклонить',
  args: { initialProposal: workflowProposal('prompt', { status: 'interrupted', after: null, message: 'Задание оборвалось при закрытии программы.' }) },
  play: ReadyWithoutMaterials.play
};
export const Cancelled: Story = {
  name: 'Подготовка остановлена пользователем · можно отклонить',
  args: { initialProposal: workflowProposal('prompt', { status: 'cancelled', after: null, message: productionTexts.main.workflow.jobCancelled }) },
  play: ReadyWithoutMaterials.play
};
export const Applied: Story = {
  name: 'Уже применено · действий предложения больше нет',
  args: { initialProposal: workflowProposal('description', { status: 'applied', before: WORKFLOW_STORY_DESCRIPTION }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Применить предложение' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Отклонить предложение' })).not.toBeInTheDocument();
  }
};
export const Busy: Story = {
  name: 'Пакет занят · просмотр доступен, запись заблокирована',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Отклонить предложение' })).toBeDisabled();
  }
};
export const SameText: Story = {
  name: 'Одинаковые тексты · применение не запрещается сравнением',
  args: {
    initialProposal: workflowProposal('prompt', { before: 'Камера неподвижна.', after: { schemaVersion: 1, stage: 'prompt', prompt: 'Камера неподвижна.' } })
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: 'Применить предложение' })).toBeEnabled();
  }
};
export const SaveFailureRetry: Story = {
  name: 'Сбой записи · сохранённое не теряется · повтор и сброс во время записи',
  args: { failFirst: true, delay: 500 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const apply = async (): Promise<void> => {
      await userEvent.click(canvas.getByRole('button', { name: 'Применить предложение' }));
      await userEvent.click(within(body.getByRole('dialog')).getByRole('button', { name: 'Применить' }));
      await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    };
    await apply();
    await waitFor(() => expect(canvas.getByText('Не удалось сохранить изменения. Материалы и предложение сохранены для повтора.')).toBeInTheDocument());
    await expect(canvas.getByTestId('saved-materials')).toHaveTextContent('Герой стоит перед воротами.');
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeEnabled();
    await apply();
    await waitFor(() => expect(canvas.getByTestId('saved-materials')).toHaveTextContent(WORKFLOW_STORY_DESCRIPTION));
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await apply();
    await expect(canvas.getByRole('status')).toHaveTextContent('Сохраняем изменения…');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
    // Ждём дольше отложенной записи: отменённый таймер не должен вернуть ошибку или изменить исходные материалы.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(canvas.queryByText('Не удалось сохранить изменения. Материалы и предложение сохранены для повтора.')).not.toBeInTheDocument();
    await expect(canvas.getByTestId('saved-materials')).toHaveTextContent('Герой стоит перед воротами.');
    await expect(canvas.getByRole('button', { name: 'Применить предложение' })).toBeEnabled();
  }
};

const longParagraph =
  'Герой медленно подходит к воротам, останавливается у левого столба и смотрит на освещённое окно. Сохранить цвет куртки, форму машины и направление вечернего света. ';
const longProposal: ProductionProposal = workflowProposal('description', {
  before: Array.from({ length: 20 }, (_, index) => `Сохранённый фрагмент ${index + 1}. ${longParagraph.repeat(2)}`).join('\n\n'),
  after: {
    schemaVersion: 1,
    stage: 'description',
    description: Array.from({ length: 24 }, (_, index) => `Предложенный фрагмент ${index + 1}. ${longParagraph.repeat(2)}`).join('\n\n'),
    requestSeconds: 8,
    keyframes: [
      {
        id: 'K01',
        role: 'first',
        timeSeconds: 0,
        prompt: longParagraph.repeat(4),
        referencePaths: ['source/очень длинное название папки с референсами/сохранить форму старых ворот и одежду героя/начало/story-image.png']
      },
      {
        id: 'K02',
        role: 'last',
        timeSeconds: 8,
        prompt: longParagraph.repeat(4),
        referencePaths: ['source/очень длинное название папки с референсами/сохранить форму старых ворот и одежду героя/конец/story-image.png']
      }
    ]
  }
});
export const LongDialog: Story = {
  name: 'Полный диалог · длинные тексты и пути · локальная прокрутка · ошибка и повтор',
  args: { initialProposal: longProposal, dialog: true, failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Просмотреть предложение и сравнение' }));
    let dialog = body.getByRole('dialog', { name: /Предложение для производства/ });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Закрыть без применения' })).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Просмотреть предложение и сравнение' }));
    dialog = body.getByRole('dialog', { name: /Предложение для производства/ });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Применить предложение' }));
    await userEvent.click(within(body.getByRole('dialog', { name: 'Применить предложение?' })).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(within(dialog).getByText('Не удалось сохранить изменения. Материалы и предложение сохранены для повтора.')).toBeInTheDocument());
    await expect(canvas.getByTestId('saved-materials')).toHaveTextContent('Сохранённый фрагмент 1.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Применить предложение' }));
    await userEvent.click(within(body.getByRole('dialog', { name: 'Применить предложение?' })).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-materials')).toHaveTextContent('Предложенный фрагмент 1.');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Просмотреть предложение и сравнение' }));
    await expect(body.getByRole('dialog', { name: /Предложение для производства/ })).toBeInTheDocument();
    await userEvent.click(body.getByRole('button', { name: 'Закрыть без применения' }));
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
