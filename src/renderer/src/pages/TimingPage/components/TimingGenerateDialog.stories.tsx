/** Состояния рабочего окна отдельно от полной страницы: защита закрытия и отказ отмены. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { JobInfo } from '@shared/types';
import { commonTexts } from '@shared/texts/common';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { timingTexts } from '@shared/texts/timing';
import { timingLocalInspection, installCustomWhisperStoryModel } from '../../../testing/timingLocalStories';
import { timingPageOptions } from '../../../testing/timingPageStories';
import { ActionButton } from '../../../components/ActionButton';
import { TimingGenerateDialog } from './TimingGenerateDialog';

function Journey({ running = false, initialVocals = false, initialModel = '' }: { running?: boolean; initialVocals?: boolean; initialModel?: string }) {
  const [open, setOpen] = useState(true);
  const [vocals, setVocals] = useState(initialVocals);
  const [model, setModel] = useState(initialModel);
  const [reset, setReset] = useState(false);
  const [device, setDevice] = useState<'auto' | 'cpu'>('auto');
  const [job, setJob] = useState<JobInfo | null>(
    running
      ? {
          id: 'demo-running',
          kind: 'tool',
          title: texts.jobTitle,
          status: 'running',
          project: '/mock/timing-project',
          startedAt: '2026-11-02T10:00:00Z',
          finishedAt: null,
          code: null,
          log: 'Уточнение границ: 2/12\n{"status":"running","internal":"diagnostic-only"}',
          steps: [{ tool: 'align_lyrics', label: texts.vocals, status: 'running', code: null }]
        }
      : null
  );
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Открыть окно разметки</ActionButton>
      <TimingGenerateDialog
        project="/mock/timing-project"
        open={open}
        model={model}
        vocals={vocals}
        job={job}
        working={false}
        error={null}
        device={device}
        resetAll={reset}
        canGenerate={!job || job.status !== 'running'}
        generateBlockedReason={null}
        onVocalsChange={setVocals}
        onStop={async () => {
          setJob((value) => (value ? { ...value, status: 'failed', error: texts.cancelled } : null));
          return true;
        }}
        onCancelDownload={async (id) => {
          let job = await window.api.timing.cancel(id);
          while (job.status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const next = await window.api.jobs.get(id);
            if (!next) throw new Error(texts.vocalJobMissing);
            job = next;
          }
        }}
        onClose={() => setOpen(false)}
        onModelChange={setModel}
        onDeviceChange={setDevice}
        onResetChange={setReset}
        onGenerate={() => undefined}
      />
    </>
  );
}
const meta = {
  title: 'Тайминги/Окно локальной разметки',
  component: Journey,
  tags: ['!autodocs'],
  parameters: { songframe: timingPageOptions({ local: 'installed' }), controls: { disable: true } },
  render: (args) => <Journey {...args} />
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Basic: Story = { name: 'Обычный режим · выбор модели и обработки' };
export const InstalledVocals: Story = { name: 'Вокал · установленный комплект · предупреждения видны', args: { initialVocals: true } };
export const ProtectedRunning: Story = {
  name: 'Обработка · Esc и фон не закрывают · остановка сохраняет окно',
  tags: ['ci'],
  args: { running: true, initialVocals: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const modal = within(await screen.findByRole('dialog'));
    const progress = await modal.findByRole('status', { name: texts.progress });
    await expect(progress).toHaveTextContent(texts.running);
    await expect(progress).not.toHaveTextContent('diagnostic-only');
    const log = modal.getByText(/Уточнение границ: 2\/12/);
    await expect(log).not.toBeVisible();
    const details = log.closest('details')!;
    await expect(details).not.toHaveAttribute('open');
    await userEvent.click(within(details).getByText(texts.technicalLog));
    await expect(log).toBeVisible();
    await expect(log).toHaveTextContent('{"status":"running","internal":"diagnostic-only"}');
    await userEvent.click(within(details).getByText(texts.technicalLog));
    await expect(log).not.toBeVisible();
    // Координаты проверяют закреплённую строку действий при обеих ширинах витрины.
    const cancel = modal.getByRole('button', { name: commonTexts.cancel });
    const footer = cancel.closest('.MuiDialogActions-root')!;
    const cancelBox = cancel.getBoundingClientRect();
    await expect(cancelBox.left - footer.getBoundingClientRect().left).toBeLessThan(28);
    await expect(cancelBox.right).toBeLessThan(modal.getByRole('button', { name: commonTexts.run }).getBoundingClientRect().left);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('dialog').closest('.MuiDialog-root')!.querySelector('.MuiDialog-container')!);
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(modal.getByRole('button', { name: commonTexts.stop }));
    await expect(await modal.findByText(texts.cancelled)).toBeVisible();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
export const DownloadCancelFailure: Story = {
  name: 'Загрузка · отказ остановки оставляет окно · повтор отмены',
  tags: ['ci'],
  args: { initialVocals: true },
  parameters: { songframe: timingPageOptions({ local: 'cancel-error' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const modal = within(await screen.findByRole('dialog'));
    // Разблокировка ActionButton перемонтирует кнопку вместе с обёрткой подсказки.
    await waitFor(() => expect(modal.getByRole('button', { name: texts.install })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: texts.install }));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.cancel })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await expect(await modal.findByText('Не удалось остановить обработку. Повторите отмену.')).toBeVisible();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};

export const ReopenKeepsChoices: Story = {
  name: 'Явная отмена · повторное открытие сохраняет режим и настройки',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    let modal = within(await screen.findByRole('dialog'));
    await userEvent.click(modal.getByRole('radio', { name: texts.vocals }));
    await userEvent.click(modal.getByRole('button', { name: texts.whisperSettings }));
    await userEvent.click(modal.getByRole('combobox', { name: timingTexts.processing }));
    await userEvent.click(await screen.findByRole('option', { name: timingTexts.cpuOnly }));
    await userEvent.click(modal.getByRole('checkbox', { name: timingTexts.resetAll }));
    await expect(modal.getByText(texts.resetWarning)).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Открыть окно разметки' }));
    modal = within(await screen.findByRole('dialog'));
    await expect(modal.getByRole('radio', { name: texts.vocals })).toBeChecked();
    await expect(modal.getByRole('button', { name: texts.whisperSettings })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(modal.getByRole('button', { name: texts.whisperSettings }));
    await expect(modal.getByRole('combobox', { name: timingTexts.processing })).toHaveTextContent(timingTexts.cpuOnly);
    await expect(modal.getByRole('checkbox', { name: timingTexts.resetAll })).toBeChecked();
    await expect(modal.queryByText(texts.ready)).not.toBeInTheDocument();
  }
};

export const CachedSelectionReopen: Story = {
  name: 'Выбор вокала сохраняется при закрытии · без автоматического ASR',
  tags: ['ci'],
  args: { initialVocals: true },
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    let modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('combobox', { name: texts.vocalResult }));
    await userEvent.click(await screen.findByRole('option', { name: 'Kim Vocal 1 · 2' }));
    await userEvent.click(modal.getByRole('button', { name: `${texts.vocalSelect}: Kim Vocal 1` }));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.cancel })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Открыть окно разметки' }));
    modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await expect(modal.getByRole('button', { name: `${texts.vocalSelect}: Kim Vocal 1` })).toBeDisabled();
    await expect(modal.getByRole('combobox', { name: texts.vocalResult })).toBeEnabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingLocalInspection().separations).toHaveLength(0);
  }
};
export const CancelPreparation: Story = {
  name: 'Отмена окна останавливает отдельное выделение и ждёт завершения',
  tags: ['ci'],
  args: { initialVocals: true },
  parameters: { songframe: timingPageOptions({ local: 'vocal-running' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: texts.separateVocal })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: texts.separateVocal }));
    await userEvent.keyboard('{Escape}');
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(timingLocalInspection().cancels).toBe(1);
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const CancelBothPreparations: Story = {
  name: 'Отмена ждёт выделение вокала и загрузку CTC',
  tags: ['ci'],
  args: { initialVocals: true },
  parameters: { songframe: timingPageOptions({ local: 'vocal-cancel-pending' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await expect(await modal.findByRole('status', { name: texts.progress })).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.cancel })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expect(modal.getByRole('button', { name: commonTexts.cancel })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 });
    await expect(timingLocalInspection().cancels).toBe(2);
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const CompactInitial: Story = {
  name: 'Два источника · готовность Whisper · настройки свёрнуты',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const modal = within(await screen.findByRole('dialog'));
    const notice = modal.getAllByRole('alert')[0];
    await expect(notice).toHaveTextContent(texts.recognitionNotice);
    await expect(notice).toHaveClass('MuiAlert-standardInfo');
    await expect(notice).toBeVisible();
    await expect(modal.getByRole('radio', { name: 'Исходный трек' })).toBeChecked();
    await expect(modal.getByRole('radio', { name: 'Сначала выделить вокал' })).not.toBeChecked();
    await expect(await modal.findByText('Whisper medium · модель установлена')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Настройки распознавания' })).toHaveAttribute('aria-expanded', 'false');
    await expect(modal.queryByRole('combobox', { name: timingTexts.processing })).not.toBeInTheDocument();
    await expect(modal.getByRole('button', { name: 'Запустить' })).toBeEnabled();
  }
};

export const MissingWhisperDownload: Story = {
  name: 'Whisper отсутствует · явная загрузка · повторная проверка готовности',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'whisper-download' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await expect(await modal.findByText('Whisper medium · модель отсутствует')).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: timingTexts.download({ model: 'medium' }) })).toBeEnabled());
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await userEvent.click(modal.getByRole('button', { name: timingTexts.download({ model: 'medium' }) }));
    await expect(await modal.findByRole('status', { name: texts.progress })).toBeVisible();
    await expect(modal.queryByRole('radio', { name: texts.basic })).not.toBeInTheDocument();
    await expect(await modal.findByText('Whisper medium · модель установлена', {}, { timeout: 5000 })).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await expect(modal.queryByRole('button', { name: timingTexts.download({ model: 'medium' }) })).not.toBeInTheDocument();
    await expect(timingLocalInspection().whisperDownloads).toEqual(['medium']);
  }
};

export const DownloadWithoutFiles: Story = {
  name: 'Задание завершено без файлов Whisper · запуск остаётся заблокирован',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'whisper-files-missing' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: timingTexts.download({ model: 'medium' }) })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: timingTexts.download({ model: 'medium' }) }));
    await waitFor(() => expect(modal.getByText(texts.modelsNotInstalled)).toBeVisible(), { timeout: 5000 });
    await waitFor(() => expect(modal.queryByRole('status', { name: texts.progress })).not.toBeInTheDocument());
    // MUI скрывает нативный radio через opacity: проверяем видимую группу и доступность её выбора.
    await expect(modal.getByRole('radiogroup', { name: texts.mode })).toBeVisible();
    await expect(modal.getByRole('radio', { name: texts.basic })).toBeEnabled();
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const CustomModelMissingRetry: Story = {
  name: 'Выбранная папка Whisper · нет файлов · повторная проверка',
  tags: ['ci'],
  args: { initialModel: '/mock/custom-whisper-model' },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await expect(await modal.findByText('Whisper · в выбранной папке нет готовой модели.')).toBeVisible();
    await expect(modal.getByText(/Не найдены файлы модели: model.bin, config.json, tokenizer.json/)).toBeVisible();
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    installCustomWhisperStoryModel();
    await userEvent.click(modal.getByRole('button', { name: texts.retryRead }));
    await expect(await modal.findByText('Whisper · выбранная папка модели проверена, файлы готовы.')).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};

export const CustomModelReady: Story = {
  name: 'Готовая модель Whisper в выбранной папке · без загрузки',
  tags: ['ci'],
  args: { initialModel: '/mock/custom-whisper-model' },
  parameters: { songframe: timingPageOptions({ local: 'whisper-custom-ready' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await expect(await modal.findByText('Whisper · выбранная папка модели проверена, файлы готовы.')).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await expect(timingLocalInspection().whisperDownloads).toHaveLength(0);
  }
};

export const StaleModelPath: Story = {
  name: 'Старый путь Whisper после переноса · запуск заблокирован',
  tags: ['ci'],
  args: { initialModel: '/mock/old-whisper-location' },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body),
      modal = within(await screen.findByRole('dialog'));
    await expect(await modal.findByText('Whisper · в выбранной папке нет готовой модели.')).toBeVisible();
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await userEvent.click(modal.getByRole('button', { name: texts.retryRead }));
    await expect(await modal.findByText('Whisper · в выбранной папке нет готовой модели.')).toBeVisible();
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
