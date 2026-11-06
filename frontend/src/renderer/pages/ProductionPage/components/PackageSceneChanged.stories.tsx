/** Решение о постановке меняет флаг пакета только после подтверждения и успешной записи. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { SceneChangedStory, queuedPackage } from '../../../testing/productionQueueStories';

const texts = productionTexts.packageSceneChanged;

const meta = {
  title: 'Производство/Пакет/Постановка изменена',
  component: SceneChangedStory,
  // Диалог и редактор переводят фокус; последовательности запускаются в Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <SceneChangedStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof SceneChangedStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeSend: Story = { name: 'До отправки · оставить попытку или доработать' };
const sent = queuedPackage();
export const AfterSend: Story = {
  name: 'После отправки · оставить для новой постановки нельзя',
  args: {
    initialPackage: {
      ...sent,
      sceneChanged: true,
      stage: 'submitted',
      waitReason: null,
      decision: { stage: 'request_choice', verdict: 'send' },
      request: { ...sent.request!, attemptStatus: 'submitted', generationId: 'demo-video-01' }
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: texts.retain })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: texts.revise })).toBeEnabled();
  }
};
export const Busy: Story = { name: 'Сохранение выполняется · оба решения заблокированы', args: { busy: true } };
export const Retain: Story = {
  name: 'Оставить попытку · отмена, подтверждение и сброс',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: texts.retain }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: texts.retain })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: texts.retain }));
    dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: texts.confirm }));
    await canvas.findByText('Постановка пакета актуальна: sceneChanged = false.');
    await expect(canvas.queryByRole('button', { name: texts.retain })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('button', { name: texts.retain })).toBeEnabled();
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};
export const Revision: Story = {
  name: 'Доработка · фокус и черновик нужной попытки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: texts.revise }));
    const input = await canvas.findByRole('textbox', { name: 'Что изменить в описании этого пакета' });
    await expect(input).toHaveFocus();
    await expect(canvas.getByText('Доработка пакета: plan/awaiting/M02-video-01')).toBeInTheDocument();
    await userEvent.type(input, 'Сохранить ворота и изменить положение героя.');
    await expect(input).toHaveValue('Сохранить ворота и изменить положение героя.');
    await expect(canvas.getByRole('button', { name: texts.retain })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
  }
};
export const FailureRetry: Story = {
  name: 'Ошибка записи · прежняя постановка до успешного повтора',
  args: { failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const retain = async (): Promise<void> => {
      await userEvent.click(canvas.getByRole('button', { name: texts.retain }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: texts.confirm }));
    };
    await retain();
    await canvas.findByText('Не удалось сохранить соответствие постановке. Пакет сохранён; повторите решение.');
    await expect(canvas.queryByText('Постановка пакета актуальна: sceneChanged = false.')).not.toBeInTheDocument();
    await retain();
    await canvas.findByText('Постановка пакета актуальна: sceneChanged = false.');
  }
};
