/** Реальный MP3 и hook проверяют загрузку волны, ограниченное прослушивание и остановку без Electron. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { timingTexts } from '@shared/texts/timing';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TimingStory, timingStoryOptions } from '../../../testing/timingStories';

const meta = {
  title: 'Тайминги/Прослушивание',
  component: TimingStory,
  tags: ['!autodocs'],
  args: { showPlayer: true },
  parameters: { songframe: timingStoryOptions(), controls: { disable: true } },
  render: (args) => <TimingStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof TimingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Проверяем штатную загрузку audio и декодирование волны, не заменяя методы воспроизведения заглушками. */
async function readyAudio(canvasElement: HTMLElement): Promise<HTMLAudioElement> {
  const audio = canvasElement.querySelector('audio');
  if (!audio) throw new Error('Плеер истории не создал audio.');
  await waitFor(() => expect(audio.readyState).toBeGreaterThanOrEqual(2), { timeout: 10000 });
  await waitFor(() => expect(within(canvasElement).queryByText('Загрузка волны…')).not.toBeInTheDocument(), { timeout: 10000 });
  return audio;
}

export const ListenLine: Story = {
  name: 'Подсказка строки · прослушивание до границы · пауза · повторное открытие',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const audio = await readyAudio(canvasElement);
    const firstPlay = canvas.getAllByRole('button', { name: 'Воспроизвести строку' })[0];
    await userEvent.hover(firstPlay);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Прослушать строку');
    await userEvent.unhover(firstPlay);
    await userEvent.click(firstPlay);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрана строка 1');
    await waitFor(() => expect(audio.paused).toBe(false));
    await waitFor(() => expect(audio.paused).toBe(true), { timeout: 5000 });
    await expect(audio.currentTime).toBeGreaterThanOrEqual(0.9);
    await expect(audio.currentTime).toBeLessThan(1.3);
    await expect(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' })).not.toBeChecked();
    // Прослушивание не подтверждает строку автоматически, выбор и правка остаются разными действиями.
    await userEvent.click(canvas.getAllByRole('button', { name: 'Воспроизвести строку' })[1]);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Пауза' })).toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Пауза' }));
    await expect(audio.paused).toBe(true);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрана строка 2');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую разметку заново' }));
    const reopened = await readyAudio(canvasElement);
    await expect(reopened).not.toBe(audio);
    await expect(reopened.paused).toBe(true);
    await expect(canvas.getByRole('status')).toHaveTextContent('Строка не выбрана');
  }
};
export const LoadingWaveform: Story = {
  name: 'Загрузка волны · готовый трек',
  args: { delayedMedia: true },
  parameters: { songframe: timingStoryOptions({ delayedMedia: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Загрузка волны…')).toBeInTheDocument();
    await readyAudio(canvasElement);
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  }
};
export const BrokenMedia: Story = {
  name: 'Ошибка трека · восстановление волны и прослушивания',
  args: { variant: 'media-error' },
  parameters: { songframe: timingStoryOptions({ variant: 'media-error' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(
      'Не удалось загрузить волну: демонстрационный трек недоступен. Восстановите трек и повторите прослушивание.',
      {},
      { timeout: 10000 }
    );
    // Ошибка воспроизведения тоже должна оставаться обработанной: браузерный прогон дополнительно ловит unhandled rejection.
    await userEvent.click(canvas.getByRole('button', { name: 'Воспроизвести' }));
    await waitFor(() => expect(canvasElement.querySelector('audio')?.paused).toBe(true));
    await expect(canvas.queryByRole('button', { name: 'Пауза' })).not.toBeInTheDocument();
    await waitFor(() => expect(canvas.getAllByRole('alert').some((alert) => alert.textContent?.startsWith('Не удалось воспроизвести трек:'))).toBe(true));
    await userEvent.click(canvas.getByRole('button', { name: 'Восстановить демонстрационный трек' }));
    const audio = await readyAudio(canvasElement);
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Воспроизвести строку' })[0]);
    await waitFor(() => expect(audio.paused).toBe(false));
    await waitFor(() => expect(audio.paused).toBe(true), { timeout: 5000 });
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрана строка 1');
  }
};
export const NarrowPlayer: Story = {
  name: 'Плеер · перенос управления в узкой области',
  parameters: { songframe: { ...timingStoryOptions(), workspaceWidth: 724 } }
};

export const ManualDragAcrossNeighbours: Story = {
  name: 'Ручной режим · пересечения · перенос мышью · прокрутка · скобки · сохранение',
  tags: ['ci'],
  args: { variant: 'manual-overlap', manualMode: true },
  parameters: { songframe: { ...timingStoryOptions({ variant: 'manual-overlap', manualMode: true }), workspaceWidth: 724 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const audio = await readyAudio(canvasElement);
    const wave = canvasElement.querySelector('canvas');
    const scroller = wave?.parentElement;
    if (!wave || !scroller) throw new Error('История не создала волну и её прокрутку.');
    const point = (time: number, lane = 0): { clientX: number; clientY: number } => {
      const rect = wave.getBoundingClientRect();
      return { clientX: rect.left + time * 48 - scroller.scrollLeft, clientY: rect.top + 43 + lane * 42 };
    };
    const start = (): HTMLInputElement => canvas.getByRole('textbox', { name: 'Начало строки 1' }) as HTMLInputElement;
    const end = (): HTMLInputElement => canvas.getByRole('textbox', { name: 'Конец строки 1' }) as HTMLInputElement;

    // Даже при выбранной первой строке перекрытый сосед доступен на собственной дорожке.
    await userEvent.pointer([{ target: wave, coords: point(2), keys: '[MouseLeft]' }]);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрана строка 1');
    await userEvent.pointer([{ target: wave, coords: point(4, 1), keys: '[MouseLeft]' }]);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрана строка 2');

    // Тащим исходные 1..5 через оба соседних блока; прокрутка происходит с зажатой кнопкой.
    await userEvent.pointer([
      { target: wave, coords: point(2), keys: '[MouseLeft>]' },
      { target: wave, coords: point(10) }
    ]);
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 300, ...point(10) }));
    await waitFor(() => expect(scroller.scrollLeft).toBeGreaterThan(0));
    await userEvent.pointer([
      { target: wave, coords: point(13) },
      { target: wave, coords: point(13), keys: '[/MouseLeft]' }
    ]);
    await waitFor(() => expect(start()).toHaveValue('12'));
    await expect(end()).toHaveValue('16');

    // Обратный интервал сохраняет обе ручки; исправление не требует отмены всей ручной сессии.
    await userEvent.pointer([
      { target: wave, coords: point(16), keys: '[MouseLeft>]' },
      { target: wave, coords: point(10) },
      { target: wave, coords: point(10), keys: '[/MouseLeft]' }
    ]);
    await waitFor(() => expect(end()).toHaveValue('10'));
    await expect(start()).toHaveValue('12');
    await expect(canvas.getAllByRole('alert')).toHaveLength(1);
    await expect(canvas.getByRole('alert')).toHaveTextContent(timingTexts.manualModeHint);
    (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
    audio.pause();
    audio.currentTime = 4;
    await userEvent.keyboard('[[');
    await waitFor(() => expect(start()).toHaveValue('4'));
    audio.currentTime = 16;
    await userEvent.keyboard(']');
    await waitFor(() => expect(end()).toHaveValue('16'));
    audio.currentTime = 12;
    await userEvent.keyboard('[[');
    await waitFor(() => expect(start()).toHaveValue('12'));

    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Разметка сохранена');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую разметку заново' }));
    await readyAudio(canvasElement);
    // После записи номера нормализованы по времени: перенесённая первая строка стала третьей.
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('12');
    await expect(canvas.getByRole('textbox', { name: 'Конец строки 3' })).toHaveValue('16');
  }
};
