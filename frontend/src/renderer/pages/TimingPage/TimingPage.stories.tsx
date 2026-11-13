/** Настоящая страница проверяет свободный ввод, сохранение и повторное чтение отдельной локальной модели. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Stack } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { timingTexts } from '@shared/texts/timing';
import { timingSelectionTexts as selectionTexts } from '@shared/texts/timing-selection';
import { timingEditorTexts as editorTexts } from '@shared/texts/timing-editor';
import { AppValueProvider, useApp } from '../../state';
import { changeVocalStorySource, timingLocalInspection } from '../../testing/timingLocalStories';
import { songTimingTexts } from '@shared/texts/song-timing';
import { ActionButton } from '../../components/ActionButton';
import { TIMING_PAGE_SAVE_ERROR, timingPageInspection, timingPageOptions } from '../../testing/timingPageStories';
import { TimingPage } from './TimingPage';
import { timingWaveLayout } from './timingWaveGeometry';

/** Перемонтирование заново читает API, а не копирует текущую форму в видимость сохранённого результата. */
function TimingPageJourney({ switchProject = false }: { switchProject?: boolean }) {
  const app = useApp();
  const [project, setProject] = useState(app.state?.current ?? '');
  const [epoch, setEpoch] = useState(0);
  return (
    <Stack spacing={2}>
      <ActionButton onClick={() => setEpoch((current) => current + 1)}>Открыть сохранённую страницу заново</ActionButton>
      {switchProject && <ActionButton onClick={() => setProject('/mock/other-timing-project')}>Сменить проект в модели</ActionButton>}
      <AppValueProvider value={{ ...app, state: app.state ? { ...app.state, current: project } : null }}>
        <TimingPage key={epoch} />
      </AppValueProvider>
    </Stack>
  );
}

const meta = {
  title: 'Страницы/Тайминги',
  component: TimingPage,
  tags: ['!autodocs'],
  parameters: { songframe: timingPageOptions(), controls: { disable: true } },
  render: () => <TimingPageJourney />
} satisfies Meta<typeof TimingPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Regular: Story = {
  name: 'Обычный режим по умолчанию',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    // Плашка о связи разметки со сценарием видна сразу, до любых правок.
    const notice = await within(canvasElement).findByRole('alert', { name: timingTexts.scenarioNotice.title });
    await expect(notice).toHaveTextContent(timingTexts.scenarioNotice.text);
    // Список строк показывает всю карту секций: часть текста без скобок и финал без строк, с границами.
    const list = within(within(canvasElement).getByRole('region', { name: editorTexts.list }));
    await expect(list.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Куплет', 'Финал без вокала']);
    await expect(canvasElement.querySelector('[data-section="Финал без вокала"]')).toHaveTextContent(/до конца трека.* – 30\.00 · /);
    // Подпись считает те же секции, что видны заголовками, и не обещает ручных секций.
    await expect(within(canvasElement).getByText(timingTexts.sectionsHelp({ count: 2 }))).toBeInTheDocument();
  }
};

/** Клики по source_line различают одинаковые припевы и раскрывают единственную рабочую строку. */
async function selectSource(canvasElement: HTMLElement, number: number): Promise<void> {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: new RegExp(`^Строка текста ${number} `) }));
}

async function openAutomatic(canvasElement: HTMLElement): Promise<void> {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: editorTexts.recognize }));
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('menuitem', { name: editorTexts.automatic }));
}

/** Успешная разметка закрывает окно, итог — в уведомлении страницы. */
async function expectTimingReady(canvasElement: HTMLElement): Promise<void> {
  const screen = within(canvasElement.ownerDocument.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 });
  await expect(await screen.findByText(songTimingTexts.ready)).toBeVisible();
}

async function enterManual(canvasElement: HTMLElement): Promise<void> {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: editorTexts.recognize }));
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('menuitem', { name: editorTexts.manual }));
}

export const ManualBoundaryRoundTrip: Story = {
  tags: ['ci'],
  name: 'Ручная правка · пересечение · черновик · исправление · повторное открытие',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await enterManual(canvasElement);
    await selectSource(canvasElement, 2);
    const start = canvas.getByRole('textbox', { name: 'Начало строки 2' });
    const end = canvas.getByRole('textbox', { name: 'Конец строки 2' });
    await userEvent.clear(start);
    await userEvent.type(start, '12');
    await userEvent.clear(end);
    await userEvent.type(end, '16');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await canvas.findByText('Строки 2 и 4 пересекаются.')).toBeVisible();
    await selectSource(canvasElement, 3);
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('12');
    for (const [number, begin, finish] of [
      [3, '17', '19'],
      [4, '20', '23']
    ] as const) {
      await selectSource(canvasElement, number);
      const beginField = canvas.getByRole('textbox', { name: `Начало строки ${number}` });
      const endField = canvas.getByRole('textbox', { name: `Конец строки ${number}` });
      await userEvent.clear(beginField);
      await userEvent.type(beginField, begin);
      await userEvent.clear(endField);
      await userEvent.type(endField, finish);
    }
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.map(({ source_line, start, end }) => ({ source_line, start, end }))).toEqual([
      { source_line: 2, start: 12, end: 16 },
      { source_line: 3, start: 17, end: 19 },
      { source_line: 4, start: 20, end: 23 }
    ]);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('12');
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const ManualIncompleteBoundary: Story = {
  tags: ['ci'],
  name: 'Пропуск в середине · пустые поля · сырой черновик переживает строки и фильтры',
  parameters: { songframe: timingPageOptions({ editor: 'gaps' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectSource(canvasElement, 3);
    const start = canvas.getByRole('textbox', { name: 'Начало строки 3' });
    await expect(start).toHaveValue('');
    await expect(canvas.getByRole('textbox', { name: 'Конец строки 3' })).toHaveValue('');
    await userEvent.type(start, 'ещё не время');
    await selectSource(canvasElement, 6);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.remaining }));
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('ещё не время');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await canvas.findByText(editorTexts.partial({ number: 3 }))).toBeVisible();
    await expect(timingPageInspection().requests).toHaveLength(0);
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Начало строки 3' }));
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.map((line) => line.source_line)).toEqual([2, 4, 6]);
  }
};

export const ManualSaveFailure: Story = {
  tags: ['ci'],
  name: 'Ошибка записи · поля сохраняются · повтор успешен',
  parameters: { songframe: timingPageOptions({ failSaveOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectSource(canvasElement, 2);
    const start = canvas.getByRole('textbox', { name: 'Начало строки 2' });
    await userEvent.clear(start);
    await userEvent.type(start, '0.25');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await canvas.findByRole('alert', { name: timingTexts.saveProblemsTitle })).toHaveTextContent(TIMING_PAGE_SAVE_ERROR);
    await expect(start).toHaveValue('0.25');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(2));
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const VerificationFilter: Story = {
  tags: ['ci'],
  name: 'Осталось · подтверждение выбирает следующую · все исходные строки в счётчике',
  parameters: { songframe: timingPageOptions({ editor: 'gaps' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('подтверждено 1 из 4');
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.remaining }));
    await selectSource(canvasElement, 2);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verify }));
    await expect(canvas.queryByRole('button', { name: /^Строка текста 2 / })).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('');
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verified }));
    await selectSource(canvasElement, 2);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.unverify }));
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.all }));
    await expect(canvas.getAllByRole('button', { name: /^Строка текста/ })).toHaveLength(4);
  }
};

export const CandidateBoundaries: Story = {
  tags: ['ci'],
  name: 'Кандидат пересекается с принятой строкой · Save сохраняет предложение отдельно',
  parameters: { songframe: timingPageOptions({ editor: 'candidates' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('1');
    await expect(canvas.getByText(/Причина сомнения: Низкая акустическая оценка/)).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Примечание к строке 3' }), 'Проверить тихий вход');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.map((line) => line.source_line)).toEqual([2, 4, 6]);
    await expect(timingPageInspection().saved.timing?.candidates).toHaveLength(1);
    await expect(timingPageInspection().saved.timing?.candidates?.[0].note).toBe('Проверить тихий вход');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: 'Примечание к строке 3' })).toHaveValue('Проверить тихий вход');
    for (const [name, value] of [
      ['Начало строки 3', '4'],
      ['Конец строки 3', '7']
    ] as const) {
      const field = canvas.getByRole('textbox', { name });
      await userEvent.clear(field);
      await userEvent.type(field, value);
    }
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verify }));
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().saved.timing?.candidates).toEqual([]));
    await expect(timingPageInspection().saved.timing?.lines.find((line) => line.source_line === 3)).toMatchObject({ start: 4, end: 7, verified: true });
  }
};

export const ReorderRepeatedChorus: Story = {
  tags: ['ci'],
  name: 'Одинаковые припевы · клавиатурная перестановка · Save · порядок текста',
  parameters: { songframe: timingPageOptions({ editor: 'gaps' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = await canvas.findByRole('button', { name: editorTexts.reorder({ number: 6 }) });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await expect(
      canvas.getAllByRole('button', { name: /^Строка текста/ }).map((button) => button.closest('[data-source-line]')?.getAttribute('data-source-line'))
    ).toEqual(['2', '3', '6', '4']);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().saved.timing?.line_order).toEqual([2, 3, 6, 4]));
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await canvas.findByRole('button', { name: editorTexts.reorder({ number: 6 }) });
    await expect(
      canvas.getAllByRole('button', { name: /^Строка текста/ }).map((button) => button.closest('[data-source-line]')?.getAttribute('data-source-line'))
    ).toEqual(['2', '3', '6', '4']);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.sourceOrder }));
    await expect(
      canvas.getAllByRole('button', { name: /^Строка текста/ }).map((button) => button.closest('[data-source-line]')?.getAttribute('data-source-line'))
    ).toEqual(['2', '3', '4', '6']);
  }
};

export const LocalTimingNotesRoundTrip: Story = {
  tags: ['ci'],
  name: 'Автоматическая разметка · ручная заметка и подтверждённые строки сохранены',
  parameters: { songframe: timingPageOptions({ local: 'vocal-cached' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await selectSource(canvasElement, 2);
    const note = canvas.getByRole('textbox', { name: timingTexts.lineNote({ id: 2 }) });
    await userEvent.clear(note);
    await userEvent.type(note, 'Моя ручная заметка');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    const before = timingPageInspection().saved;
    await openAutomatic(canvasElement);
    const dialog = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expectTimingReady(canvasElement);
    await expect(timingLocalInspection().starts[0].vocals).toBe(true);
    await expect(timingPageInspection().saved.timing!.lines[1]).toEqual(before.timing!.lines[1]);
    await expect(timingPageInspection().saved.timing!.sections).toEqual(before.timing!.sections);
    // Повторное открытие начинается с чистого окна: журнал и итог прошлого задания не показываются.
    await openAutomatic(canvasElement);
    const reopened = within(await screen.findByRole('dialog'));
    await expect(reopened.queryByText(songTimingTexts.technicalLog)).not.toBeInTheDocument();
    await expect(reopened.queryByRole('status', { name: songTimingTexts.progress })).not.toBeInTheDocument();
    await userEvent.click(reopened.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('12');
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineNote({ id: 2 }) })).toHaveValue('Моя ручная заметка');
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verify }));
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(2));
  }
};

export const VocalTimingWithDownload: Story = {
  name: 'Локальная разметка · скачать модели · вокал · сохранить подтверждения',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'download' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: songTimingTexts.separateVocal })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: songTimingTexts.separateVocal }));
    await expect(await modal.findByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }, { timeout: 5000 })).toBeEnabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await userEvent.click(modal.getByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }));
    const before = timingPageInspection().saved;
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    const download = await modal.findByRole('button', { name: 'Скачать модель уточнения границ' });
    await waitFor(() => expect(download).toBeEnabled());
    await userEvent.click(download);
    await userEvent.keyboard('{Escape}');
    await expect(screen.getByRole('dialog')).toBeVisible();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expect(await modal.findByRole('status', { name: songTimingTexts.progress })).toBeVisible();
    await userEvent.click(screen.getByRole('dialog').closest('.MuiDialog-root')!.querySelector('.MuiDialog-container')!);
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expectTimingReady(canvasElement);
    await expect(timingPageInspection().saved.timing!.lines[1]).toEqual(before.timing!.lines[1]);
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('12');
  }
};
export const VocalTimingFailureRetry: Story = {
  name: 'Локальная разметка · ошибка уточнения · прежние границы · повтор',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'failure' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const before = timingPageInspection().saved;
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: songTimingTexts.separateVocal })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: songTimingTexts.separateVocal }));
    await expect(await modal.findByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }, { timeout: 5000 })).toBeEnabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await userEvent.click(modal.getByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expect(await modal.findByText('Не удалось уточнить границы. Прежняя разметка сохранена.', {}, { timeout: 5000 })).toBeVisible();
    await expect(timingPageInspection().saved).toEqual(before);
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expectTimingReady(canvasElement);
  }
};
export const TimingCancellation: Story = {
  name: 'Локальная разметка · остановка без закрытия · явная отмена',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'running' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const before = timingPageInspection().saved;
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    // Прослушивание сравнения останавливается при запуске: скрытый плеер не должен продолжать играть.
    await userEvent.click(modal.getByRole('button', { name: `${songTimingTexts.vocalPreview}: Voc FT` }));
    const comparison = within(modal.getByRole('group', { name: commonTexts.player.controls }));
    const audio = screen.getByRole('dialog').querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(1));
    await userEvent.click(comparison.getByRole('button', { name: commonTexts.player.play }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(audio.isConnected).toBe(true);
    const progress = await modal.findByRole('status', { name: songTimingTexts.progress });
    await expect(progress).toHaveTextContent(songTimingTexts.running);
    await expect(progress).not.toHaveTextContent('diagnostic-only');
    const log = modal.getByText(/Уточнение границ: 1\/3/);
    await expect(log).not.toBeVisible();
    await userEvent.click(within(log.closest('details')!).getByText(songTimingTexts.technicalLog));
    await expect(log).toBeVisible();
    await expect(log).toHaveTextContent('{"status":"running","internal":"diagnostic-only"}');
    const cancel = modal.getByRole('button', { name: commonTexts.cancel });
    const footer = cancel.closest('.MuiDialogActions-root')!;
    await expect(cancel.getBoundingClientRect().left - footer.getBoundingClientRect().left).toBeLessThan(28);

    await userEvent.click(await modal.findByRole('button', { name: commonTexts.stop }));
    await expect(await modal.findByText('Разметка остановлена пользователем.', {}, { timeout: 5000 })).toBeVisible();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expect(timingPageInspection().saved).toEqual(before);
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
export const TimingPartialResult: Story = {
  name: 'Локальная разметка · первая строка не найдена · без интерполяции вступления',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'partial' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expectTimingReady(canvasElement);
    await expect(timingPageInspection().saved.timing!.lines.some((line) => line.source_line === 2)).toBe(false);
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('');
    await expect(canvas.getByRole('textbox', { name: 'Конец строки 2' })).toHaveValue('');
  }
};
export const TimingResultReadRetry: Story = {
  name: 'Локальная разметка · ошибка чтения результата · повтор без новой обработки',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'reload-failure' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expect(await modal.findByText('Не удалось прочитать записанный результат. Повторите чтение.', {}, { timeout: 5000 })).toBeVisible();
    await expect(modal.queryByText(songTimingTexts.ready)).not.toBeInTheDocument();
    await userEvent.click(modal.getByRole('button', { name: songTimingTexts.reloadResult }));
    await expectTimingReady(canvasElement);
    await expect(timingLocalInspection().starts).toHaveLength(1);
  }
};
export const TimingStartFailureRetry: Story = {
  name: 'Локальная разметка · ошибка запуска · сохранность данных · повтор',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'start-failure' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const before = timingPageInspection().saved;
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expect(await modal.findByText('Не удалось запустить разметку. Повторите запуск.')).toBeVisible();
    await expect(timingPageInspection().saved).toEqual(before);
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expectTimingReady(canvasElement);
    await expect(timingLocalInspection().starts).toHaveLength(2);
  }
};
export const TimingUnsavedDraft: Story = {
  name: 'Локальная разметка · незавершённый ручной ввод блокирует запуск',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'installed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = timingPageInspection().saved;
    await enterManual(canvasElement);
    await selectSource(canvasElement, 2);
    const start = canvas.getByRole('textbox', { name: 'Начало строки 2' });
    await userEvent.clear(start);
    await userEvent.type(start, 'ещё не время');
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.recognize }));
    await expect(within(canvasElement.ownerDocument.body).getByRole('menuitem', { name: editorTexts.automatic })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await expect(start).toHaveValue('ещё не время');
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingPageInspection().saved).toEqual(before);
  }
};
export const TimingProjectChangeDuringStart: Story = {
  name: 'Локальная разметка · поздний запуск прежнего проекта не меняет новый',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'delayed-start' }) },
  render: () => <TimingPageJourney switchProject />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    // Внешняя смена контекста не должна дождаться start старого проекта и открыть чужое задание.
    canvas.getByText('Сменить проект в модели').click();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('30');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('30');
    await expect(canvas.getByRole('button', { name: editorTexts.recognize })).toBeEnabled();
  }
};

export const TimingMissingJob: Story = {
  name: 'Локальная разметка · задание пропало · ошибка без успеха · явное закрытие',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'missing-job' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      screen = within(canvasElement.ownerDocument.body);
    const before = timingPageInspection().saved;
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.run }));
    await expect(await modal.findByText(songTimingTexts.noJob, {}, { timeout: 5000 })).toBeVisible();
    await expect(modal.queryByText(songTimingTexts.ready)).not.toBeInTheDocument();
    await expect(timingPageInspection().saved).toEqual(before);
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: editorTexts.recognize })).toBeEnabled();
  }
};

export const VocalSelectionReopenAndSourceChange: Story = {
  name: 'Вокал · явный выбор · повторное открытие · смена трека блокирует Run',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'installed' }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    let modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: songTimingTexts.separateVocal })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: songTimingTexts.separateVocal }));
    await expect(await modal.findByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }, { timeout: 5000 })).toBeEnabled();
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await userEvent.click(modal.getByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openAutomatic(canvasElement);
    modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await expect(modal.getByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` })).toBeDisabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingLocalInspection().separations).toHaveLength(1);
    changeVocalStorySource();
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled(), { timeout: 5000 });
    await expect(modal.queryByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` })).not.toBeInTheDocument();
    await expect(timingLocalInspection().starts).toHaveLength(0);
  }
};
export const VocalWithoutLyrics: Story = {
  name: 'Вокал без текста · выделение доступно · ASR заблокирован',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'installed', withoutLyrics: true }) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await openAutomatic(canvasElement);
    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByRole('button', { name: songTimingTexts.separateVocal })).toBeEnabled());
    await userEvent.click(modal.getByRole('button', { name: songTimingTexts.separateVocal }));
    await userEvent.click(await modal.findByRole('button', { name: `${songTimingTexts.vocalSelect}: Voc FT` }, { timeout: 5000 }));
    await waitFor(() => expect(modal.getByRole('button', { name: commonTexts.cancel })).toBeEnabled());
    await expect(modal.getByRole('button', { name: commonTexts.run })).toBeDisabled();
    await expect(timingLocalInspection().starts).toHaveLength(0);
    await expect(timingLocalInspection().selections).toHaveLength(1);
  }
};

/** Ошибка загрузки не скрывает повтор; модель возвращает данные только после явного действия. */
export const LoadFailureRetry: Story = {
  tags: ['ci'],
  name: 'Ошибка чтения · повтор загружает исходные строки',
  parameters: {
    songframe: {
      ...timingPageOptions(),
      createApi: () => {
        const session = timingPageOptions().createApi!();
        if (!('api' in session)) throw new Error('История требует локальную API-сессию.');
        const original = session.api.timing.view;
        let failed = false;
        session.api.timing.view = async (project) => {
          if (!failed) {
            failed = true;
            throw new Error('Не удалось прочитать разметку. Повторите загрузку.');
          }
          return original(project);
        };
        return session;
      }
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Не удалось прочитать разметку. Повторите загрузку.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.retry }));
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toHaveValue('0');
  }
};

export const LoopNavigation: Story = {
  tags: ['ci'],
  name: 'Настоящий плеер · V с фокусом на «Повторять» · смена рабочей строки прекращает повтор и звук',
  parameters: { songframe: timingPageOptions({ local: 'installed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await selectSource(canvasElement, 2);
    const audio = canvasElement.querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.loopSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await expect(canvas.getByRole('button', { name: selectionTexts.stopLoop })).toHaveAttribute('aria-pressed', 'true');
    // Фокус остался на кнопке «Повторять», но V по-прежнему подтверждает выделенную строку.
    await expect(canvas.getByRole('button', { name: selectionTexts.stopLoop })).toHaveFocus();
    await expect(canvas.getByRole('button', { name: editorTexts.verify })).toBeVisible();
    await userEvent.keyboard('v');
    await waitFor(() => expect(canvas.queryByRole('button', { name: editorTexts.verify })).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.next }));
    await expect(audio.paused).toBe(true);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: selectionTexts.stopLoop })).not.toBeInTheDocument();
  }
};

export const VerifiedTimingLock: Story = {
  tags: ['ci'],
  name: 'Ручной режим · подтверждённая строка на шкале · V · перенос · сохранение',
  parameters: { songframe: timingPageOptions({ local: 'installed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await enterManual(canvasElement);
    await selectSource(canvasElement, 2);
    const audio = canvasElement.querySelector('audio')!;
    await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    await waitFor(() => expect(canvas.queryByText(timingTexts.loadingWaveform)).not.toBeInTheDocument(), { timeout: 10000 });
    const wave = canvasElement.querySelector('canvas')!;
    const scroller = wave.parentElement!;
    scroller.scrollLeft = 16 * 48;
    scroller.dispatchEvent(new Event('scroll'));
    const point = (time: number) => ({
      clientX: wave.getBoundingClientRect().left + time * 48 - scroller.scrollLeft,
      clientY: wave.getBoundingClientRect().top + 43
    });
    const drag = async (from: number, to: number) => {
      await userEvent.pointer([
        { target: wave, coords: point(from), keys: '[MouseLeft>]' },
        { target: wave, coords: point(to) },
        { target: wave, coords: point(to), keys: '[/MouseLeft]' }
      ]);
    };
    const expectLocked = async () => {
      await expect(canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 3 }) })).toHaveValue('17');
      await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 3 }) })).toHaveValue('19');
      await expect(canvas.getByRole('button', { name: editorTexts.unverify })).toBeVisible();
      await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
      await expect(timingPageInspection().requests).toHaveLength(0);
    };

    // Выбор подтверждённого блока работает и не меняет документ при попытке сдвинуть тело или границы.
    await drag(18, 17.5);
    await expect(canvas.getByText(timingTexts.lockedLine({ id: 3 }))).toBeVisible();
    await expectLocked();
    await drag(17, 16);
    await expectLocked();
    await drag(19, 20);
    await expectLocked();
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    audio.currentTime = 16;
    await userEvent.keyboard('[[');
    await expectLocked();
    audio.currentTime = 20;
    await userEvent.keyboard(']');
    await expectLocked();

    // Явное V разрешает перенос; повторное чтение сверяет сохранённые границы и снятое подтверждение.
    await userEvent.keyboard('v');
    await expect(canvas.getByRole('button', { name: editorTexts.verify })).toBeVisible();
    await expect(canvas.queryByText(timingTexts.lockedLine({ id: 3 }))).not.toBeInTheDocument();
    scroller.scrollLeft = 12 * 48;
    scroller.dispatchEvent(new Event('scroll'));
    await drag(18, 13);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 3 }) })).toHaveValue('12');
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 3 }) })).toHaveValue('14');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.find((line) => line.source_line === 3)).toMatchObject({ start: 12, end: 14, verified: false });
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 3 }) })).toHaveValue('12');
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 3 }) })).toHaveValue('14');
    await expect(canvas.getByRole('button', { name: editorTexts.verify })).toBeVisible();
  }
};

export const KeyboardRespectsFilterAndEmptyRange: Story = {
  tags: ['ci'],
  name: 'Горячие клавиши · пустую строку нельзя подтвердить · навигация только по фильтру',
  parameters: { songframe: timingPageOptions({ editor: 'gaps' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const blurControl = () => (canvasElement.ownerDocument.activeElement as HTMLElement).blur();
    await userEvent.click(await canvas.findByRole('button', { name: editorTexts.remaining }));
    await selectSource(canvasElement, 3);
    blurControl();
    await userEvent.keyboard('v');
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('');
    await expect(canvas.getByRole('button', { name: editorTexts.verify })).toBeDisabled();
    await selectSource(canvasElement, 2);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verify }));
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verified }));
    await selectSource(canvasElement, 2);
    blurControl();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 4' })).toBeVisible();
    await expect(canvas.queryByRole('textbox', { name: 'Начало строки 3' })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowUp}');
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 2' })).toBeVisible();
    await userEvent.keyboard('v');
    await expect(canvas.queryByRole('button', { name: /^Строка текста 2 / })).not.toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 4' })).toBeVisible();
  }
};

/** Настоящий canvas и Ctrl+Click проверяют выбор без подмены состояния hook. */
async function readySelectionWave(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('button', { name: /^Строка текста 2 / });
  const audio = canvasElement.querySelector('audio')!;
  await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(2), { timeout: 10000 });
  await waitFor(() => expect(canvas.queryByText(timingTexts.loadingWaveform)).not.toBeInTheDocument(), { timeout: 10000 });
  const wave = canvasElement.querySelector('canvas')!;
  const scroller = wave.parentElement!;
  // Один сеанс ввода сохраняет Control/Shift между клавиатурой и последовательностью pointer.
  const input = userEvent.setup({ document: canvasElement.ownerDocument });
  const point = (time: number, y = 43) => ({
    clientX: wave.getBoundingClientRect().left + time * 48 - scroller.scrollLeft,
    clientY: wave.getBoundingClientRect().top + y
  });
  const click = async (time: number, ctrl = false, y = 43) => {
    if (ctrl) await input.keyboard('{Control>}');
    await input.pointer([{ target: wave, coords: point(time, y), keys: '[MouseLeft]' }]);
    if (ctrl) await input.keyboard('{/Control}');
  };
  const drag = async (from: number, to: number) => {
    await input.pointer([
      { target: wave, coords: point(from), keys: '[MouseLeft>]' },
      { target: wave, coords: point(to) },
      { target: wave, coords: point(to), keys: '[/MouseLeft]' }
    ]);
  };
  const pair = async () => {
    await click(0.6);
    // Касающиеся блоки занимают разные дорожки, а fixture с промежутком оставляет вторую строку на первой.
    const timing = timingPageInspection().saved.timing;
    const rows = [
      ...(timing?.lines ?? []).map((line) => ({ ...line, id: line.source_line })),
      ...(timing?.candidates ?? []).map((candidate) => ({ ...candidate, id: candidate.source_line }))
    ];
    const second = timingWaveLayout(rows, 48, true).blocks.find((block) => block.line.source_line === 3);
    if (!second) throw new Error('Вторая строка пары отсутствует на шкале.');
    await click(1.7, true, second.top + second.height / 2);
    await expect(canvas.getByText(selectionTexts.pair({ first: 2, second: 3 }))).toBeVisible();
  };
  return { audio, wave, scroller, point, click, drag, pair, input };
}

export const PairJoinRoundTrip: Story = {
  tags: ['ci'],
  name: 'Ctrl+Click пары · выбор без правок · общая ручка · Save · повторное открытие',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const original = timingPageInspection().saved;
    await selection.pair();
    await expect(canvas.getByRole('button', { name: selectionTexts.listenJoin })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
    await expect(timingPageInspection().saved).toEqual(original);
    // Обе границы изменяются одной ручкой; внешние края и привязки исходного текста остаются прежними.
    await selection.drag(1.2, 1.5);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.slice(0, 2)).toMatchObject([
      { source_line: 2, start: 0.3, end: 1.5 },
      { source_line: 3, start: 1.5, end: 2.2 }
    ]);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await selectSource(canvasElement, 2);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.5');
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 3 }) })).toHaveValue('1.5');
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();

    // После свежего drag горячая клавиша использует новые границы обеих строк, не снимок до переноса.
    const reopened = await readySelectionWave(canvasElement);
    await reopened.pair();
    await reopened.drag(1.5, 1.6);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.6');
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    await reopened.input.keyboard('v');
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.6');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(2));
    await expect(timingPageInspection().saved.timing?.lines.slice(0, 2)).toMatchObject([
      { source_line: 2, start: 0.3, end: 1.6, verified: true },
      { source_line: 3, start: 1.6, end: 2.2, verified: true }
    ]);
  }
};

export const GestureUndoAndNudge: Story = {
  tags: ['ci'],
  name: 'Отмена жеста · Ctrl+Z и кнопки · точная подстройка ←/→ без записи файла',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const field = (kind: 'start' | 'end', id: number) =>
      canvas.getByRole('textbox', { name: kind === 'start' ? timingTexts.lineStart({ id }) : timingTexts.lineEnd({ id }) });
    const blur = () => (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    // Кнопки перестраиваются при смене доступности: каждый раз берём текущий элемент.
    const undo = () => canvas.getByRole('button', { name: selectionTexts.undo });
    const redo = () => canvas.getByRole('button', { name: selectionTexts.redo });
    await expect(undo()).toBeDisabled();
    await expect(redo()).toBeDisabled();

    // Перенос общей ручки меняет две строки за много движений мыши — это один шаг отмены.
    await selection.pair();
    await selection.input.pointer([
      { target: selection.wave, coords: selection.point(1.2), keys: '[MouseLeft>]' },
      { target: selection.wave, coords: selection.point(1.3) },
      { target: selection.wave, coords: selection.point(1.4) },
      { target: selection.wave, coords: selection.point(1.5) },
      { target: selection.wave, coords: selection.point(1.5), keys: '[/MouseLeft]' }
    ]);
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.5'));
    await waitFor(() => expect(canvas.getByText(selectionTexts.joinReady({ time: '1.50' }))).toBeVisible());
    blur();
    await selection.input.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.2'));
    await waitFor(() => expect(canvas.getByText(selectionTexts.joinReady({ time: '1.20' }))).toBeVisible());
    // Возврат к исходному черновику снимает признак несохранённых правок.
    await waitFor(() => expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled());
    await expect(undo()).toBeDisabled();
    await selection.input.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.5'));
    await userEvent.click(undo());
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.2'));
    await userEvent.click(redo());
    await waitFor(() => expect(canvas.getByText(selectionTexts.joinReady({ time: '1.50' }))).toBeVisible());

    // ←/→ двигают общий стык пары на 0,05 с, Ctrl — на 0,01 с; каждое нажатие — свой шаг.
    blur();
    await selection.input.keyboard('{ArrowRight}');
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.55'));
    await selection.input.keyboard('{Control>}{ArrowLeft}{/Control}');
    await waitFor(() => expect(canvas.getByText(selectionTexts.joinReady({ time: '1.54' }))).toBeVisible());
    await selection.input.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.55'));

    // Одна строка: ←/→ — начало, Shift+←/→ — конец.
    await selection.click(0.6);
    await expect(canvas.getByText(selectionTexts.line({ id: 2 }))).toBeVisible();
    blur();
    await selection.input.keyboard('{ArrowLeft}');
    await waitFor(() => expect(field('start', 2)).toHaveValue('0.25'));
    await selection.input.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await waitFor(() => expect(field('end', 2)).toHaveValue('1.5'));
    await expect(timingPageInspection().requests).toHaveLength(0);

    // Сохранение начинает историю заново: отменять в сохранённый файл нечего.
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines[0]).toMatchObject({ source_line: 2, start: 0.25, end: 1.5 });
    await waitFor(() => expect(canvas.getByRole('button', { name: selectionTexts.undo })).toBeDisabled());
  }
};

export const SnapAndFollow: Story = {
  tags: ['ci'],
  name: 'Прилипание к плейхеду · Shift временно отключает · слежение за воспроизведением',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const snap = canvas.getByRole('switch', { name: selectionTexts.snap });
    const follow = canvas.getByRole('switch', { name: selectionTexts.follow });
    await expect(snap).not.toBeChecked();
    await expect(follow).toBeChecked();
    selection.audio.currentTime = 1.53;
    await waitFor(() => expect(canvas.getByText(/^0:01\.5/)).toBeVisible());

    // Без прилипания граница встаёт ровно под мышь.
    await selection.pair();
    await selection.drag(1.2, 1.5);
    await waitFor(() => expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.5'));
    await userEvent.click(snap);
    await expect(snap).toBeChecked();
    // С прилипанием стык притягивается к плейхеду, который ближе 8 px.
    await selection.drag(1.5, 1.45);
    await waitFor(() => expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.53'));
    // Shift, нажатый после захвата, на время жеста возвращает свободный перенос.
    await selection.input.pointer([{ target: selection.wave, coords: selection.point(1.53), keys: '[MouseLeft>]' }]);
    await selection.input.keyboard('{Shift>}');
    await selection.input.pointer([
      { target: selection.wave, coords: selection.point(1.48) },
      { target: selection.wave, coords: selection.point(1.48), keys: '[/MouseLeft]' }
    ]);
    await selection.input.keyboard('{/Shift}');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) })).toHaveValue('1.48'));
    await userEvent.click(snap);

    // Без слежения волна стоит на месте, пока плейхед уходит за край; включение возвращает прокрутку.
    await userEvent.click(follow);
    await expect(follow).not.toBeChecked();
    const scale = canvas.getByRole('slider', { name: selectionTexts.timelineScale });
    scale.focus();
    await userEvent.keyboard('{End}');
    selection.scroller.scrollLeft = 0;
    selection.scroller.dispatchEvent(new Event('scroll'));
    selection.audio.currentTime = 6;
    await selection.audio.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(selection.scroller.scrollLeft).toBe(0);
    await userEvent.click(follow);
    await waitFor(() => expect(selection.scroller.scrollLeft).toBeGreaterThan(0));
    selection.audio.pause();
  }
};

export const MixedCandidatePairNoteRoundTrip: Story = {
  tags: ['ci'],
  name: 'Смешанная пара · V не принимает кандидата · новая заметка · подтверждение · Save',
  parameters: { songframe: timingPageOptions({ selection: 'mixed-candidate-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    await selection.pair();
    await expect(canvas.getByText(selectionTexts.lockedPair)).toBeVisible();
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    await selection.input.keyboard('v');
    await expect(canvas.queryByText(selectionTexts.lockedPair)).not.toBeInTheDocument();
    await selectSource(canvasElement, 3);
    const note = canvas.getByRole('textbox', { name: timingTexts.lineNote({ id: 3 }) });
    await expect(note).toHaveValue('Проверить тихий вход');
    await userEvent.clear(note);
    await userEvent.type(note, 'Тихий вход проверен на слух');
    await expect(note).toHaveValue('Тихий вход проверен на слух');
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.verify }));
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.candidates).toEqual([]);
    await expect(timingPageInspection().saved.timing?.lines.find((line) => line.source_line === 3)).toMatchObject({
      verified: true,
      note: 'Тихий вход проверен на слух'
    });
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await selectSource(canvasElement, 3);
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineNote({ id: 3 }) })).toHaveValue('Тихий вход проверен на слух');
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const GapExplicitJoin: Story = {
  tags: ['ci'],
  name: 'Промежуток пары · выбор сохраняет тишину · явное соединение в курсоре',
  parameters: { songframe: timingPageOptions({ selection: 'gapped-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    await selection.pair();
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
    selection.audio.currentTime = 1;
    await waitFor(() => expect(canvas.getByRole('button', { name: selectionTexts.joinAtPlayhead })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.joinAtPlayhead }));
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.slice(0, 2)).toMatchObject([
      { source_line: 2, start: 0.3, end: 1 },
      { source_line: 3, start: 1, end: 2.2 }
    ]);
  }
};

export const LockedPairJoin: Story = {
  tags: ['ci'],
  name: 'Подтверждённая половина пары · стык закрыт · явное снятие проверки разрешает ручку',
  parameters: { songframe: timingPageOptions({ selection: 'locked-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    await selection.pair();
    await selection.drag(1.2, 1.5);
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
    await expect(timingPageInspection().requests).toHaveLength(0);
    await selectSource(canvasElement, 3);
    await userEvent.click(canvas.getByRole('button', { name: editorTexts.unverify }));
    await selection.pair();
    await selection.drag(1.2, 1.5);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(timingPageInspection().requests).toHaveLength(1));
    await expect(timingPageInspection().saved.timing?.lines.slice(0, 2)).toMatchObject([
      { source_line: 2, end: 1.5, verified: false },
      { source_line: 3, start: 1.5, verified: false }
    ]);
  }
};

export const PairPlaybackAndClearing: Story = {
  tags: ['ci'],
  name: 'Пара · прослушивание до края · повтор · стык · очистка и смена выбора останавливают звук',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const { audio } = selection;
    await selection.pair();
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.playSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    audio.currentTime = 2.25;
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(audio.currentTime).toBeLessThan(2.4);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.loopSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    audio.currentTime = 2.25;
    await waitFor(() => expect(audio.currentTime).toBeLessThan(0.8));
    await expect(audio.paused).toBe(false);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.listenJoin }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await expect(audio.currentTime).toBeLessThan(1.3);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.wholeSelection }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.playSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.clearSelection }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(canvas.getByRole('button', { name: selectionTexts.loopSelection })).toBeDisabled();
    await selection.pair();
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.loopSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await selection.click(3);
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const SelectionZoomKeepsTime: Story = {
  tags: ['ci'],
  name: 'Выделение и масштаб · время и разметка сохраняются · панель доступна после прокрутки',
  parameters: { songframe: { ...timingPageOptions({ selection: 'joined-pair' }), workspaceWidth: 724 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    await selection.pair();
    selection.audio.currentTime = 0.7;
    const before = timingPageInspection().saved;
    const scale = canvas.getByRole('slider', { name: selectionTexts.timelineScale });
    const oldScale = Number(scale.getAttribute('aria-valuenow'));
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.wholeTrack }));
    await waitFor(() => expect(Number(scale.getAttribute('aria-valuenow'))).toBeLessThan(oldScale));
    await expect(selection.audio.currentTime).toBeCloseTo(0.7, 1);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.zoomSelection }));
    await waitFor(() => expect(Number(scale.getAttribute('aria-valuenow'))).toBeGreaterThan(oldScale));
    await expect(selection.audio.currentTime).toBeCloseTo(0.7, 1);
    await expect(timingPageInspection().saved).toEqual(before);
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
    // Страница использует штатную оболочку: после прокрутки controls остаются внутри минимальной рабочей области.
    const panel = canvas.getByRole('group', { name: selectionTexts.controls }).parentElement;
    if (!panel) throw new Error('Панель плеера не найдена.');
    canvas.getByRole('button', { name: /^Строка текста 4 / }).scrollIntoView();
    await waitFor(() => expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0));
    await expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(canvasElement.getBoundingClientRect().right + 1);
  }
};

export const FreeRangePlayback: Story = {
  tags: ['ci'],
  name: 'Shift+drag по волне · произвольный диапазон · повтор и очистка без изменения строк',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const before = timingPageInspection().saved;
    await selection.input.keyboard('{Shift>}');
    await selection.drag(4, 5);
    await selection.input.keyboard('{/Shift}');
    await expect(canvas.getByText(selectionTexts.range)).toBeVisible();
    await expect(canvas.getByRole('button', { name: selectionTexts.zoomSelection })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.loopSelection }));
    await waitFor(() => expect(selection.audio.paused).toBe(false));
    selection.audio.currentTime = 5.1;
    await waitFor(() => expect(selection.audio.currentTime).toBeLessThan(4.5));
    await expect(selection.audio.currentTime).toBeGreaterThanOrEqual(4);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.clearSelection }));
    await waitFor(() => expect(selection.audio.paused).toBe(true));
    await expect(canvas.getByText(selectionTexts.noSelection)).toBeVisible();
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
    await expect(timingPageInspection().saved).toEqual(before);
  }
};

export const PairDraftAndSeekRegressions: Story = {
  tags: ['ci'],
  name: 'Пара · временно пустая граница · перемотка и пауза · разрыв стыка возвращает всё выделение',
  parameters: { songframe: timingPageOptions({ selection: 'joined-pair' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = await readySelectionWave(canvasElement);
    const { audio } = selection;
    const before = timingPageInspection().saved;
    const pairLabel = selectionTexts.pair({ first: 2, second: 3 });
    const end = () => canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 2 }) });
    await selection.pair();
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.loopSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));

    // Незавершённый ввод приостанавливает цикл, сохраняя обе выбранные строки и намерение повторять их.
    await userEvent.clear(end());
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(canvas.getByText(pairLabel)).toBeVisible();
    await expect(canvas.getByRole('button', { name: selectionTexts.stopLoop })).toHaveAttribute('aria-pressed', 'true');
    await expect(end()).toHaveValue('');
    await userEvent.type(end(), '1.2');
    await waitFor(() => expect(audio.paused).toBe(false));
    await expect(canvas.getByText(pairLabel)).toBeVisible();
    await expect(canvas.getByRole('button', { name: selectionTexts.stopLoop })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.stopLoop }));
    await waitFor(() => expect(audio.paused).toBe(true));

    // Перемотка за выделение снимает ограниченный интервал; последующая пауза сохраняет выбранную позицию.
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.playSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await selection.click(4);
    await waitFor(() => expect(audio.currentTime).toBeGreaterThanOrEqual(4));
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.pause }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(audio.currentTime).toBeGreaterThanOrEqual(4);
    const pausedAt = audio.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(audio.currentTime).toBe(pausedAt);
    await expect(canvas.getByText(pairLabel)).toBeVisible();

    // Правка общей границы в промежуток завершает режим стыка и возвращает доступное прослушивание всей пары.
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.listenJoin }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await expect(canvas.getByRole('button', { name: selectionTexts.wholeSelection })).toBeVisible();
    await userEvent.clear(end());
    await userEvent.type(end(), '0.8');
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(canvas.getByText(pairLabel)).toBeVisible();
    await expect(canvas.getByRole('button', { name: selectionTexts.joinAtPlayhead })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: selectionTexts.listenJoin })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: selectionTexts.wholeSelection })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.playSelection }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await expect(audio.currentTime).toBeGreaterThanOrEqual(0.3);
    await expect(audio.currentTime).toBeLessThan(1);
    await userEvent.click(canvas.getByRole('button', { name: selectionTexts.pause }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(timingPageInspection().requests).toHaveLength(0);
    await expect(timingPageInspection().saved).toEqual(before);
  }
};
