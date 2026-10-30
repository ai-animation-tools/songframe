/** Каталог использует настоящие превью, метаданные и подтверждение замены без изменения файлов. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { MONTAGE_SOURCE, MontageSourcesStory } from '../../../testing/montageStories';
import type { StoryOptions } from '../../../testing/storybook';

const meta = {
  title: 'Монтаж/Материалы сцен',
  component: MontageSourcesStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof MontageSourcesStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SearchAndAdd: Story = {
  name: 'Поиск, пустая выдача и добавление одной сцены',
  args: { initiallyEmpty: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox', { name: montageTexts.searchScene });
    await userEvent.type(search, 'отсутствующий квадрокоптер');
    await expect(canvas.getByRole('alert')).toHaveTextContent(montageTexts.nothingFound);
    await expect(canvas.queryByRole('button', { name: montageTexts.add })).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'M02');
    await expect(canvas.getByText(montageTexts.foundScenes({ found: 1, total: 3 }))).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.add }));
    await expect(
      within(canvas.getByTestId('clip-state-M02'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M02', '0', '45', '45']);
    await expect(canvas.getByTestId('montage-audio-range')).toHaveTextContent('Музыка: 45 — 90 кадров; длительность: 45 кадров');
    await expect(canvas.getByTestId('source-selection')).toHaveTextContent('Выбрано: M02');
    await expect(canvas.getByRole('button', { name: montageTexts.onTrack })).toBeDisabled();
    await userEvent.clear(search);
    await expect(canvas.getByText(montageTexts.noMaterial)).toBeInTheDocument();
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('45 кадров');
  }
};

export const ReplaceWithConfirmation: Story = {
  name: 'Замена оригинала · отмена и отдельное подтверждение',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const open = async () => {
      await userEvent.click(canvas.getAllByRole('button', { name: montageTexts.replaceCurrent })[0]);
      const element = await screen.findByRole('dialog');
      await waitFor(() => expect(element).toBeVisible());
      return within(element);
    };
    let dialog = await open();
    await expect(dialog.getByText(/Исходные файлы сохранятся/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('source-selection')).toHaveTextContent(MONTAGE_SOURCE);
    await expect(
      within(canvas.getByTestId('clip-state-M01'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M01', '15', '60', '45']);
    dialog = await open();
    await userEvent.click(dialog.getByRole('button', { name: montageTexts.replaceOnTrack }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('source-selection')).toHaveTextContent('M01: assets/shots/M01/story-derived-preview-62.mp4');
    await expect(
      within(canvas.getByTestId('clip-state-M01'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M01', '0', '45', '45']);
    await expect(
      within(canvas.getByTestId('clip-state-M02'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M02', '30', '75', '45']);
    await expect(canvas.getByTestId('source-selection')).toHaveTextContent('M01-original, M01-accepted, M01-card, M02-attempt');
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('90 кадров');
  }
};

export const BrowseMaterials: Story = {
  name: 'Просмотр · видео, масштаб опоры, стрелки и повторное открытие',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getAllByRole('button', { name: /Открыть материал:/ })[0]);
    let element = await screen.findByRole('dialog');
    await waitFor(() => expect(element).toBeVisible());
    let dialog = within(element);
    await expect(dialog.getByRole('button', { name: montageTexts.previousMaterial })).toBeDisabled();
    const originalVideo = element.querySelector('video');
    await waitFor(() => expect(originalVideo?.readyState).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    await userEvent.click(dialog.getByRole('button', { name: montageTexts.nextMaterial }));
    await expect(originalVideo?.paused).toBe(true);
    await expect(originalVideo?.getAttribute('src')).toBeNull();
    await expect(dialog.getByText(montageTexts.materialPosition({ position: 2, total: 4 }))).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    await expect(dialog.getByText(montageTexts.materialPosition({ position: 3, total: 4 }))).toBeInTheDocument();
    await waitFor(() => expect((dialog.getByRole('img') as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
    await expect(dialog.getByRole('button', { name: montageTexts.originalSize })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(dialog.getByRole('button', { name: montageTexts.fitToWindow }));
    await expect(dialog.getByRole('button', { name: montageTexts.fitToWindow })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{ArrowRight}');
    await expect(dialog.getByText(montageTexts.materialPosition({ position: 4, total: 4 }))).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: montageTexts.nextMaterial })).toBeDisabled();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(dialog.getByRole('button', { name: montageTexts.originalSize })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('source-selection')).toHaveTextContent(MONTAGE_SOURCE);
    await expect(
      within(canvas.getByTestId('clip-state-M01'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    ).toEqual(['M01', '15', '60', '45']);
    await userEvent.click(canvas.getAllByRole('button', { name: /Открыть материал:/ })[2]);
    element = await screen.findByRole('dialog');
    await waitFor(() => expect(element).toBeVisible());
    dialog = within(element);
    await expect(dialog.getByRole('button', { name: montageTexts.originalSize })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};

export const ReadMetadata: Story = {
  name: 'Длина оригиналов читается браузером · без ffprobe',
  args: { unknownMetadata: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.queryByText(montageTexts.readingLength)).not.toBeInTheDocument(), { timeout: 10000 });
    await expect(canvas.getAllByText('00:05:00')).toHaveLength(2);
    await expect(canvas.getByText('00:02:02')).toBeInTheDocument();
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('90 кадров');
  }
};

export const MissingOriginal: Story = {
  name: 'Файл оригинала потерян · ошибка превью и просмотра',
  args: { missing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByText(montageTexts.previewUnavailable)).toBeInTheDocument(), { timeout: 10000 });
    await userEvent.click(canvas.getAllByRole('button', { name: /Открыть материал:/ })[0]);
    const element = await screen.findByRole('dialog');
    await waitFor(() => expect(element).toBeVisible());
    await waitFor(() => expect(within(element).getByRole('alert')).toHaveTextContent(montageTexts.materialVideoFailed), { timeout: 10000 });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('montage-length')).toHaveTextContent('90 кадров');
  }
};

export const Narrow: Story = {
  name: 'Узкий каталог · длинные названия и все виды материалов',
  parameters: { songframe: { workspaceWidth: 580 } satisfies StoryOptions }
};
