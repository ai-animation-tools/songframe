/** Проверки решений используют рабочий диалог и видимый итог локальной модели, без файлового проекта. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { scenarioTexts } from '@shared/texts/scenario';
import { SHOT_STATE_LABELS } from '../../../components/shotState';
import { SCENARIO_DRAFT, SCENARIO_SAVE_ERROR, ScenesSaveStory } from '../../../testing/scenarioSaveStories';

const meta = {
  title: 'Сценарий/Сохранение/Последствия для производства',
  component: ScenesSaveStory,
  // Модальные окна и клавиатурные последовательности выполняются в собственном Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ScenesSaveStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ScenesSaveStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Production: Story = {
  name: 'Обычное сохранение · комплект устарел, пакет требует согласования',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog', { name: scenarioTexts.save.productionTitle });
    await expect(within(dialog).getByText('M01')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('Успешных сохранений: 1');
    await expect(canvas.getByText(SHOT_STATE_LABELS.stale.label, { exact: true })).toBeInTheDocument();
    await expect(canvas.getByTestId('package-state')).toHaveTextContent('требуется новое согласование');
    await expect(canvas.getByTestId('animatic-state')).toHaveTextContent('устарел');
    await expect(canvas.getByTestId('media-history')).toHaveTextContent('assets/M01.mp4, source/M01-original.mp4. История: 3 попытки. Сохранены.');
  }
};

export const Keep: Story = {
  name: 'Без производства · комплект и пакет сохраняют силу',
  args: { mode: 'keep' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog', { name: scenarioTexts.save.keepTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByText(SHOT_STATE_LABELS.completed.label, { exact: true })).toBeInTheDocument();
    await expect(canvas.getByTestId('package-state')).toHaveTextContent('прежнее согласование сохраняется');
    await expect(canvas.getByTestId('old-stale')).toHaveTextContent('прежнее утверждение не восстановлено');
    await expect(canvas.getByTestId('animatic-state')).toHaveTextContent('устарел');
    await expect(canvas.getByTestId('media-history')).toHaveTextContent('История: 3 попытки. Сохранены.');
  }
};

export const AlreadyStale: Story = {
  name: 'Без производства · уже устаревшее не восстанавливается',
  args: { mode: 'keep', stale: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText(SHOT_STATE_LABELS.stale.label, { exact: true })).toBeInTheDocument();
    await expect(canvas.getByTestId('package-state')).toHaveTextContent('требуется новое согласование');
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('1');
  }
};

export const CancelAndReopen: Story = {
  name: 'Отмена и Escape · повторное открытие сохраняет черновик',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('textbox', { name: 'Черновик постановки' })).toHaveValue(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('0');
    await expect(canvas.getByTestId('animatic-state')).toHaveTextContent('соответствует сохранённому реестру');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть подтверждение сохранения' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('0');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть подтверждение сохранения' }));
    await expect(await screen.findByRole('dialog')).toBeInTheDocument();
  }
};

export const FailureAndRetry: Story = {
  name: 'Ошибка записи · повтор с прежним черновиком',
  args: { failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.save }));
    await screen.findByText(SCENARIO_SAVE_ERROR);
    await expect(dialog).toBeInTheDocument();
    await expect(canvas.getByLabelText('Черновик постановки')).toHaveValue(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('0');
    await expect(canvas.getByTestId('saved-scenes')).not.toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('media-history')).toHaveTextContent('История: 3 попытки. Сохранены.');
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('1');
    await expect(screen.queryByText(SCENARIO_SAVE_ERROR)).not.toBeInTheDocument();
  }
};

export const Busy: Story = {
  name: 'Занято · подтверждение, отмена и Escape заблокированы',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('button', { name: commonTexts.save })).toBeDisabled();
    await expect(within(dialog).getByRole('button', { name: commonTexts.cancel })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await expect(dialog).toBeInTheDocument();
    await expect(canvas.getByTestId('save-count')).toHaveTextContent('0');
  }
};

export const LongList: Story = {
  name: 'Длинный список · прокрутка причин и клавиатура',
  args: { longList: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    const list = within(dialog).getByRole('list');
    await expect(within(list).getAllByRole('listitem')).toHaveLength(28);
    // Прокручивается одно содержимое диалога; список внутри него собственной прокрутки не имеет.
    const region = within(dialog).getByRole('region', { name: scenarioTexts.save.affectedShotsRegion });
    await waitFor(() => expect(region.scrollHeight).toBeGreaterThan(region.clientHeight));
    await expect(list.scrollHeight).toBe(list.clientHeight);
    // Первый Tab приводит в область прокрутки: в фокусе её прокручивают клавишами браузера.
    await userEvent.tab();
    await expect(region).toHaveFocus();
    region.scrollTop = region.scrollHeight;
    await waitFor(() => expect(within(list).getByText('M28')).toBeVisible());
    await userEvent.tab();
    await expect(dialog.contains(canvasElement.ownerDocument.activeElement)).toBe(true);
    await expect(within(dialog).getByRole('button', { name: commonTexts.save })).toBeVisible();
  }
};
