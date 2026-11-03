/** Точные операции проверяются по видимым границам обоих соседей и сохранности материалов. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { montageTexts } from '@shared/texts/montage';
import { commonTexts } from '@shared/texts/common';
import { MONTAGE_LOCKED_REASON, MONTAGE_SOURCE, MontageEditorStory } from '../../../testing/montageStories';
import type { StoryOptions } from '../../../testing/storybook';

const meta = {
  title: 'Монтаж/Точный редактор фрагмента',
  component: MontageEditorStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof MontageEditorStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TrimSlipAndCut: Story = {
  name: 'Обрезка, сдвиг и общий стык · оба соседа',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const edit = async (label: string, value: string): Promise<void> => {
      const field = canvas.getByRole('spinbutton', { name: label });
      await userEvent.clear(field);
      await userEvent.type(field, value);
      await userEvent.tab();
    };
    const row = (scene: string) =>
      within(canvas.getByTestId(`clip-state-${scene}`))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    await expect(row('M01')).toEqual(['M01', '15', '60', '45']);
    await edit(montageTexts.sourceStart, '18');
    await edit(montageTexts.sourceEnd, '66');
    await expect(row('M01')).toEqual(['M01', '18', '66', '48']);
    await expect(row('M02')).toEqual(['M02', '30', '75', '45']);
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.slipForward }));
    await expect(row('M01')).toEqual(['M01', '19', '67', '48']);
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('93 кадров');
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.cutForward }));
    await expect(row('M01')).toEqual(['M01', '19', '68', '49']);
    await expect(row('M02')).toEqual(['M02', '31', '75', '44']);
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('93 кадров');
    await expect(canvas.getByTestId('retained-materials')).toHaveTextContent(MONTAGE_SOURCE);
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(row('M01')).toEqual(['M01', '15', '60', '45']);
    await expect(row('M02')).toEqual(['M02', '30', '75', '45']);
  }
};

export const RemoveWithConfirmation: Story = {
  name: 'Удаление · Escape, отмена, подтверждение и сохранность исходника',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const open = async () => {
      await userEvent.click(canvas.getByRole('button', { name: montageTexts.removeFromTrack }));
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(dialog).toBeVisible());
      return within(dialog);
    };
    let dialog = await open();
    await expect(dialog.getByText(montageTexts.removeDescription('M01'))).toBeInTheDocument();
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.cancel })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('clip-state-M01')).toBeInTheDocument();
    dialog = await open();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('clip-state-M01')).toBeInTheDocument();
    dialog = await open();
    await userEvent.click(dialog.getByRole('button', { name: montageTexts.removeFromTrack }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByTestId('clip-state-M01')).not.toBeInTheDocument();
    await expect(
      within(canvas.getByTestId('clip-state-M02'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M02', '30', '75', '45']);
    await expect(canvas.getByTestId('retained-materials')).toHaveTextContent(MONTAGE_SOURCE);
    await expect(canvas.getByText(montageTexts.selectClipToTrim)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('spinbutton', { name: montageTexts.sourceStart })).toHaveValue(15);
  }
};

export const Card: Story = {
  name: 'Опора · длительность доступна, сдвиг запрещён',
  args: { card: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('spinbutton', { name: montageTexts.sourceStart })).toBeDisabled();
    await expect(canvas.getByRole('spinbutton', { name: montageTexts.slipFrames })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: montageTexts.slipForward })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: montageTexts.slipForward })).toHaveAttribute('title', montageTexts.cardCannotSlip);
    const end = canvas.getByRole('spinbutton', { name: montageTexts.sourceEnd });
    await userEvent.clear(end);
    await userEvent.type(end, '60');
    await userEvent.tab();
    await expect(
      within(canvas.getByTestId('clip-state-M01'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M01', '0', '60', '60']);
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('105 кадров');
  }
};

export const Busy: Story = {
  name: 'Экспорт выполняется · правки и удаление заблокированы',
  args: { locked: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const input of canvas.getAllByRole('spinbutton')) await expect(input).toBeDisabled();
    for (const name of [montageTexts.slipBackward, montageTexts.slipForward, montageTexts.cutBackward, montageTexts.cutForward, montageTexts.removeFromTrack]) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
      await expect(canvas.getByRole('button', { name })).toHaveAttribute('title', MONTAGE_LOCKED_REASON);
    }
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('90 кадров');
  }
};

export const AwaitingMetadata: Story = {
  name: 'Метаданные ещё неизвестны · расширение ограничено',
  args: { unknownMetadata: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(montageTexts.awaitSourceMetadata);
    await expect(canvas.getByRole('spinbutton', { name: montageTexts.sourceEnd })).toHaveAttribute('max', '60');
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('90 кадров');
  }
};

export const Empty: Story = { name: 'Фрагмент не выбран', args: { empty: true } };
export const NarrowLongPath: Story = {
  name: 'Узкая рабочая область · длинный путь и перенос действий',
  parameters: { songframe: { workspaceWidth: 580 } satisfies StoryOptions }
};
