/** Рабочий блок с локальным кэшем, заданиями и синтетическим аудио. */
import type { JobInfo } from '@shared/types';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack } from '@mui/material';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { timingPageOptions } from '../../../testing/timingPageStories';
import { changeVocalStorySource, failNextVocalStoryRead, timingLocalInspection } from '../../../testing/timingLocalStories';
import { VocalPreparation } from './VocalPreparation';

function Journey({ disabled = false }: { disabled?: boolean }) {
  const [ready, setReady] = useState(false);
  const [, setJob] = useState<JobInfo | null>(null);
  return (
    <Stack spacing={2}>
      <VocalPreparation project="/mock/timing-project" disabled={disabled} onReady={setReady} onJob={setJob} />
      <Alert severity={ready ? 'success' : 'info'}>{ready ? 'Разметка разрешена' : 'Разметка заблокирована'}</Alert>
    </Stack>
  );
}
const meta = {
  title: 'Тайминги/Подготовка вокала',
  component: Journey,
  tags: ['!autodocs'],
  parameters: { songframe: timingPageOptions({ local: 'installed' }), controls: { disable: true } },
  render: (args) => <Journey {...args} />
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExplicitSelection: Story = {
  name: 'Выделить · прослушать A/B · выбрать · без автоматического ASR',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateVocal })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.separateVocal }));
    await expect(await canvas.findByRole('button', { name: `${texts.vocalSelect}: Voc FT` }, { timeout: 5000 })).toBeEnabled();
    await expect(canvas.getByText('Разметка заблокирована')).toBeVisible();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await userEvent.click(canvas.getByRole('button', { name: `${texts.vocalPreview}: Voc FT` }));
    const audio = canvasElement.querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(1));
    audio.currentTime = 3;
    await userEvent.click(canvas.getByRole('button', { name: texts.originalAudio }));
    await waitFor(() => {
      expect(audio.readyState).toBeGreaterThanOrEqual(1);
      expect(audio.currentTime).toBeCloseTo(3, 1);
    });
    await expect(audio.paused).toBe(true);
    await audio.play();
    await expect(audio.paused).toBe(false);
    await userEvent.click(canvas.getByRole('button', { name: texts.vocalAudio }));
    await waitFor(() => {
      expect(audio.readyState).toBeGreaterThanOrEqual(1);
      expect(audio.paused).toBe(false);
      expect(audio.currentTime).toBeGreaterThanOrEqual(2.9);
      expect(audio.currentTime).toBeLessThan(5);
    });
    audio.pause();
    await expect(canvasElement.querySelectorAll('audio')).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: `${texts.vocalSelect}: Voc FT` }));
    await expect(await canvas.findByText('Разметка разрешена')).toBeVisible();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingLocalInspection().selections).toHaveLength(1);
    await expect(canvas.getAllByText('Вокал выбран для разметки.')).toHaveLength(1);
    await expect(canvas.queryByText('Прослушайте варианты и явно выберите вокал для разметки.')).not.toBeInTheDocument();
  }
};
export const DownloadFailureRetry: Story = {
  name: 'Voc FT · загрузка · ошибка · повтор · выделение',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-download-failure' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.downloadVocal })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.downloadVocal }));
    await expect(await canvas.findByRole('status', { name: texts.vocalProgress })).toHaveTextContent(texts.downloadingVocal);
    const downloadLog = canvas.getByText(/voc-ft: 25%/);
    await expect(downloadLog).not.toBeVisible();
    await userEvent.click(within(downloadLog.closest('details')!).getByText(texts.technicalLog));
    await expect(downloadLog).toBeVisible();
    await expect(downloadLog).toHaveTextContent('diagnostic-only');
    await expect(await canvas.findByText('Загрузка вокальной модели прервана. Повторите загрузку.', {}, { timeout: 5000 })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: texts.downloadVocal }));
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateVocal })).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(canvas.getByRole('button', { name: texts.separateVocal }));
    await expect(await canvas.findByRole('button', { name: `${texts.vocalSelect}: Voc FT` }, { timeout: 5000 })).toBeEnabled();
    await expect(timingLocalInspection().vocalDownloads).toEqual(['voc-ft', 'voc-ft']);
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
export const ExistingSelectionSurvivesFailure: Story = {
  name: 'Ошибка новой попытки сохраняет варианты и выбранный вокал',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-failure' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateAgain })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.separateAgain }));
    await expect(await canvas.findByText('Выделение не удалось. Готовые варианты и выбор сохранены.', {}, { timeout: 5000 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: `${texts.vocalSelect}: Voc FT` })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: texts.vocalResult })).toBeEnabled();
    await expect(canvas.getByText('Разметка разрешена')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: texts.separateAgain }));
    await waitFor(() => expect(timingLocalInspection().separations).toHaveLength(2), { timeout: 5000 });
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateAgain })).toBeEnabled(), { timeout: 5000 });
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
export const StopAndRetry: Story = {
  name: 'Явная остановка · повтор не запускает разметку',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-running' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateVocal })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.separateVocal }));
    const progress = await canvas.findByRole('status', { name: texts.vocalProgress });
    await expect(progress).toHaveTextContent(texts.separating);
    await expect(progress).not.toHaveTextContent('diagnostic-only');
    const log = canvas.getByText(/Выделение вокала: 1\/3/);
    await expect(log).not.toBeVisible();
    await userEvent.click(within(log.closest('details')!).getByText(texts.technicalLog));
    await expect(log).toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: texts.stopPreparation }));
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.separateVocal })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.separateVocal }));
    // Новое задание снова закрывает диагностику, даже если предыдущую раскрывали.
    await expect(canvas.getByText(/Выделение вокала: 1\/3/)).not.toBeVisible();
    await expect(canvas.getByRole('status', { name: texts.vocalProgress })).toHaveTextContent(texts.separating);
    await expect(timingLocalInspection().separations).toHaveLength(2);
    await expect(timingLocalInspection().cancels).toBe(1);
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
export const ChangedSource: Story = {
  name: 'Смена исходного трека снимает выбор и старые варианты',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-stale' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Разметка разрешена')).toBeVisible();
    changeVocalStorySource();
    await expect(await canvas.findByText('Разметка заблокирована', {}, { timeout: 5000 })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: `${texts.vocalSelect}: Voc FT` })).not.toBeInTheDocument();
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
export const RapidComparisonSwitch: Story = {
  name: 'Быстрый A/B до метаданных сохраняет позицию и воспроизведение',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: `${texts.vocalPreview}: Voc FT` }));
    const audio = canvasElement.querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(1));
    audio.currentTime = 4;
    // Два реальных клика в одном такте не дают браузеру доставить loadedmetadata между A и B.
    // flushSync завершает каждое переключение React, поэтому тест проходит через оба src плеера.
    flushSync(() => canvas.getByRole('button', { name: texts.originalAudio }).click());
    flushSync(() => canvas.getByRole('button', { name: texts.vocalAudio }).click());
    await waitFor(() => {
      expect(audio.readyState).toBeGreaterThanOrEqual(1);
      expect(audio.currentTime).toBeCloseTo(4, 1);
      expect(audio.paused).toBe(true);
    });
    await audio.play();
    flushSync(() => canvas.getByRole('button', { name: texts.originalAudio }).click());
    flushSync(() => canvas.getByRole('button', { name: texts.vocalAudio }).click());
    await waitFor(() => {
      expect(audio.readyState).toBeGreaterThanOrEqual(1);
      expect(audio.currentTime).toBeGreaterThanOrEqual(3.9);
      expect(audio.currentTime).toBeLessThan(6);
      expect(audio.paused).toBe(false);
    });
    audio.pause();
    await expect(canvasElement.querySelectorAll('audio')).toHaveLength(1);
    await expect(canvas.queryByText(texts.audioError)).not.toBeInTheDocument();
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const ReadFailureBlocksUntilRecovery: Story = {
  name: 'Ошибка обновления снимает готовность · опрос восстанавливает выбор и убирает ошибку',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Разметка разрешена')).toBeVisible();
    // Focus вызывает настоящее обновление, не дожидаясь очередного интервала опроса.
    failNextVocalStoryRead();
    window.dispatchEvent(new Event('focus'));
    await expect(await canvas.findByText('Не удалось проверить готовый вокал. Повторяем чтение.')).toBeVisible();
    await expect(canvas.getByText('Разметка заблокирована')).toBeVisible();
    await expect(canvas.getByRole('button', { name: `${texts.vocalSelect}: Voc FT` })).toBeDisabled();
    await expect(await canvas.findByText('Разметка разрешена', {}, { timeout: 5000 })).toBeVisible();
    await expect(canvas.queryByText('Не удалось проверить готовый вокал. Повторяем чтение.')).not.toBeInTheDocument();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingLocalInspection().selections).toHaveLength(0);
  }
};

export const DeleteSelected: Story = {
  name: 'Удаление выбранного WAV · отмена · успех · повторная подготовка',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: `${texts.vocalPreview}: Voc FT` }));
    const audio = canvasElement.querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(1));
    await audio.play();
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить: Voc FT' }));
    let dialog = within(await screen.findByRole('dialog', { name: texts.deleteVocalTitle }));
    await expect(canvasElement.querySelector('audio')).toBeNull();
    await expect(audio.paused).toBe(true);
    await expect(audio.hasAttribute('src')).toBe(false);
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await expect(timingLocalInspection().deletions).toHaveLength(0);
    await expect(canvas.getByText('Разметка разрешена')).toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: 'Удалить: Voc FT' }));
    dialog = within(await screen.findByRole('dialog', { name: texts.deleteVocalTitle }));
    await userEvent.click(dialog.getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Разметка заблокирована')).toBeVisible();
    await expect(await canvas.findByRole('button', { name: `${texts.vocalPreview}: Voc FT` })).toBeVisible();
    await expect(timingLocalInspection().deletions).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: texts.separateAgain }));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: texts.vocalResult })).toBeEnabled(), { timeout: 5000 });
    await expect(timingLocalInspection().separations).toEqual(['voc-ft']);
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const DeleteOther: Story = {
  name: 'Удаление второго варианта сохраняет выбранный',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('combobox', { name: texts.vocalResult }));
    await userEvent.click(await screen.findByRole('option', { name: 'Voc FT · 2' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить: Voc FT' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Разметка разрешена')).toBeVisible();
    await expect(await canvas.findByRole('button', { name: `${texts.vocalSelect}: Voc FT` })).toBeDisabled();
    await expect(timingLocalInspection().deletions).toEqual(['vocal-result-2']);
  }
};

export const DeleteFailureRetry: Story = {
  name: 'Ошибка удаления сохраняет WAV и выбор · повтор',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'vocal-delete-failure' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Удалить: Voc FT' }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Удалить' }));
    await expect(await dialog.findByText('Не удалось удалить WAV. Готовый вокал и выбор сохранены.')).toBeVisible();
    // Проверяем сохранённый выбор после явного выхода из ошибки: фон модального окна недоступен для действий.
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await expect(await canvas.findByRole('button', { name: `${texts.vocalSelect}: Voc FT` })).toBeDisabled();
    await expect(canvas.getByText('Разметка разрешена')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить: Voc FT' }));
    const retryDialog = within(await screen.findByRole('dialog'));
    await userEvent.click(retryDialog.getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Разметка заблокирована')).toBeVisible();
    await expect(timingLocalInspection().deletions).toHaveLength(2);
  }
};

export const DeleteInUse: Story = {
  name: 'ASR использует WAV · удаление заблокировано с причиной',
  tags: ['ci'],
  args: { disabled: true },
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    const button = await canvas.findByRole('button', { name: 'Удалить: Voc FT' });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.closest('span')!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(texts.vocalInUse);
    await expect(timingLocalInspection().deletions).toHaveLength(0);
  }
};
