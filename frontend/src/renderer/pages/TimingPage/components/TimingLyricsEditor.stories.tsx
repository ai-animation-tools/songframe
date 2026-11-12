/** Изолированная модель проверяет выбор, черновики и порядок; настоящий audio проверяется историей страницы. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Stack, Typography } from '@mui/material';
import type { LyricsLine, TimingLine } from '@shared/types';
import { timingEditorTexts as texts } from '@shared/texts/timing-editor';
import { TimingLyricsEditor } from './TimingLyricsEditor';
import { buildSections } from '@shared/timing-sections';
import { editorTimingRows, type TimingCandidate } from '../timingEditor';
import { parseTimingBoundary, type TimingBoundaryDrafts } from '../manualTiming';

const lyrics: LyricsLine[] = [
  { number: 1, text: '[Куплет]', header: true },
  { number: 2, text: 'У старых ворот начинается утро', header: false },
  { number: 3, text: 'Пропущенная строка в середине', header: false },
  { number: 4, text: 'И снова зовёт нас знакомая дорога', header: false },
  { number: 5, text: '[Припев]', header: true },
  { number: 6, text: 'И снова зовёт нас знакомая дорога', header: false }
];

function EditorStory({ candidate = false, complete = false }: { candidate?: boolean; complete?: boolean }) {
  const [lines, setLines] = useState<TimingLine[]>([
    { id: 2, source_line: 2, start: 0, end: 2, verified: false },
    ...(complete ? [{ id: 3, source_line: 3, start: 3, end: 5, verified: false }] : []),
    { id: 4, source_line: 4, start: 8, end: 10, verified: true },
    { id: 6, source_line: 6, start: 12, end: 14, verified: false }
  ]);
  const [candidates, setCandidates] = useState<TimingCandidate[]>(
    candidate ? [{ source_line: 3, start: 1, end: 4, reason: 'Низкая акустическая оценка', acoustic_score: 0.3 }] : []
  );
  const [order, setOrder] = useState([2, 3, 4, 6]);
  const [selected, setSelected] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<TimingBoundaryDrafts>({});
  const [stops, setStops] = useState(0);
  const rows = editorTimingRows(lyrics, lines, candidates, order);
  // Карта пересчитывается из текущих строк, как useTimingPlayer на странице.
  const sections = buildSections(lyrics, lines, 30, candidates);
  const update = (id: number, patch: Partial<TimingLine>) => {
    const row = rows.find((line) => line.id === id)!;
    setLines((current) => [...current.filter((line) => line.id !== id), { ...row, ...patch }]);
    if (patch.start !== undefined || patch.end !== undefined || patch.verified) setCandidates((current) => current.filter((line) => line.source_line !== id));
  };
  return (
    <Stack spacing={2}>
      <TimingLyricsEditor
        lyrics={lyrics}
        rows={rows}
        sections={sections}
        candidates={candidates}
        selected={selected}
        order={order}
        drafts={drafts}
        time={6}
        duration={30}
        hasTrack={true}
        playingLineId={null}
        loopingLineId={null}
        onSelect={setSelected}
        onOrder={setOrder}
        onStop={() => setStops((current) => current + 1)}
        onInput={(id, field, text) => {
          update(id, { [field]: parseTimingBoundary(text), verified: false });
          setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: text } }));
        }}
        onUpdate={update}
        onPlay={() => undefined}
        onLoop={() => undefined}
        onRemove={(id) => {
          setLines((current) => current.filter((line) => line.id !== id));
          setDrafts((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        }}
      />
      <Typography role="status">{`Остановок прослушивания: ${stops}`}</Typography>
    </Stack>
  );
}

const meta = {
  title: 'Тайминги/Редактор исходных строк',
  component: EditorStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <EditorStory {...args} />
} satisfies Meta<typeof EditorStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FullSource: Story = { name: 'Пропуск в середине и одинаковые припевы' };
export const SectionMap: Story = {
  tags: ['ci'],
  name: 'Все секции карты в списке: имена без скобок, границы пересчитываются при правке',
  args: { complete: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const headings = () => canvas.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    await expect(headings()).toEqual(['Куплет', 'Проигрыш после «Куплет»', 'Припев', 'Финал без вокала']);
    const section = (name: string) => canvasElement.querySelector(`[data-section="${name}"]`)!;
    await expect(section('Куплет')).toHaveTextContent(texts.sectionRange({ start: 0, end: 10 }));
    await expect(section('Проигрыш после «Куплет»')).toHaveTextContent('без вокала');
    await expect(section('Финал без вокала')).toHaveTextContent(texts.sectionRange({ start: 14, end: 30 }));
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 6 / }));
    const end = canvas.getByRole('textbox', { name: 'Конец строки 6' });
    await userEvent.clear(end);
    await userEvent.type(end, '20');
    await waitFor(() => expect(section('Припев')).toHaveTextContent(texts.sectionRange({ start: 12, end: 20 })));
    await expect(section('Финал без вокала')).toHaveTextContent(texts.sectionRange({ start: 20, end: 30 }));
  }
};
export const Candidate: Story = {
  name: 'Кандидат с границами и причиной сомнения',
  args: { candidate: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 3 / }));
    await expect(canvas.getByText(/Причина сомнения: Низкая акустическая оценка/)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('1');
  }
};
export const NativeDragAndKeyboard: Story = {
  tags: ['ci'],
  name: 'Drag за ручку с линией места вставки и клавиатурное перемещение сохраняют source_line',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('button', { name: texts.reorder({ number: 6 }) });
    // Нативный DragEvent сохраняет исходный DataTransfer; обёртка Storybook fireEvent подменяет этот объект.
    const browser = handle.ownerDocument.defaultView!;
    const dataTransfer = new browser.DataTransfer();
    const dispatchDrag = (element: Element, type: string) =>
      element.dispatchEvent(new browser.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    dispatchDrag(handle, 'dragstart');
    await expect(dataTransfer.getData('text/plain')).toBe('6');
    const target = canvasElement.querySelector('[data-source-line="3"]')!;
    dispatchDrag(target, 'dragover');
    // Строка 6 идёт вверх: линия вставки видна над целью, перетаскиваемая строка приглушена.
    await waitFor(() => expect(target).toHaveAttribute('data-drop-position', 'before'));
    await expect(getComputedStyle(target, '::after').height).toBe('3px');
    await expect(canvasElement.querySelector('[data-source-line="6"]')).toHaveStyle({ opacity: '0.5' });
    dispatchDrag(target, 'drop');
    await waitFor(() => expect(canvasElement.querySelector('[data-drop-position]')).toBeNull());
    dispatchDrag(handle, 'dragend');
    const numbers = () =>
      canvas.getAllByRole('button', { name: /^Строка текста/ }).map((button) => button.closest('[data-source-line]')?.getAttribute('data-source-line'));
    // React применяет последовательность native drag-событий к DOM после завершения обработчиков.
    await waitFor(() => expect(numbers()).toEqual(['2', '6', '3', '4']));
    const moved = canvas.getByRole('button', { name: texts.reorder({ number: 6 }) });
    moved.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await expect(numbers()).toEqual(['6', '2', '3', '4']);
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 6 / }));
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 6' })).toHaveValue('12');
    await userEvent.click(canvas.getByRole('button', { name: texts.sourceOrder }));
    await expect(numbers()).toEqual(['2', '3', '4', '6']);
  }
};
export const DraftAndConfirmation: Story = {
  tags: ['ci'],
  name: 'Незаконченный ввод переживает фильтр · проверка выбирает следующую',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 3 / }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Начало строки 3' }), '-ещё');
    await userEvent.click(canvas.getByRole('button', { name: texts.verified }));
    await userEvent.click(canvas.getByRole('button', { name: texts.remaining }));
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 3 / }));
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('-ещё');
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 2 / }));
    await userEvent.click(canvas.getByRole('button', { name: texts.verify }));
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('-ещё');
  }
};
export const LoopStopsOnNavigation: Story = {
  tags: ['ci'],
  name: 'Смена рабочей строки останавливает повтор',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /^Строка текста 2 / }));
    const before = Number(canvas.getByRole('status').textContent?.match(/\d+/)?.[0]);
    // Редактор сообщает общей панели об остановке; настоящее audio проверяется историей страницы.
    await userEvent.click(canvas.getByRole('button', { name: texts.next }));
    await expect(canvas.getByRole('status')).toHaveTextContent(`Остановок прослушивания: ${before + 1}`);
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 3' })).toHaveValue('');
  }
};
