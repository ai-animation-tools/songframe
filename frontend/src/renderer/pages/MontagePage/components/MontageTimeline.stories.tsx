/** Выбранный и соседний клипы проверяются вместе: контраст надписей нужен на обоих оттенках primary. */
import { useState } from 'react';
import { Stack, Typography } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { montageDraft } from '../../../testing/montageStories';
import { MontageTimeline } from './MontageTimeline';
function TimelineStory() {
  const [draft, setDraft] = useState(montageDraft);
  const [selected, setSelected] = useState<string | null>('M01');
  const [frame, setFrame] = useState(0);
  return (
    <Stack spacing={2}>
      <MontageTimeline
        draft={draft}
        duration={5}
        trackUrl={null}
        lyricLines={[]}
        lyricProblem={null}
        frame={frame}
        selected={selected}
        onSelect={setSelected}
        onSeek={setFrame}
        onChange={setDraft}
        onDropSource={() => undefined}
        onMove={() => undefined}
      />
      <Typography role="status">
        Выбрано: {selected}. Длительности: {draft.clips.map((clip) => clip.source_end_frame_exclusive - clip.source_start_frame).join(', ')}.
      </Typography>
    </Stack>
  );
}
const meta = { title: 'Монтаж/Таймлайн', component: TimelineStory, tags: ['!autodocs'] } satisfies Meta<typeof TimelineStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedAndAdjacent: Story = {
  name: 'Выбранный и соседний клип · читаемые подписи в обеих темах',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрано: M01. Длительности: 45, 45.');
    await expect(canvas.getAllByText('45 к · видео')).toHaveLength(2);
    // Надписи пропускают указатель к области клипа: выбираем тот же контейнер, что получает реальный клик.
    await userEvent.click(canvas.getByText('M02').closest<HTMLElement>('[draggable]')!);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрано: M02. Длительности: 45, 45.');
    await userEvent.click(canvas.getByText('M01').closest<HTMLElement>('[draggable]')!);
    await expect(canvas.getByRole('status')).toHaveTextContent('Выбрано: M01. Длительности: 45, 45.');
  }
};
