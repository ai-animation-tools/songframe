/** Медиа читаются из отобранных файлов витрины; состояние карточки меняется локально. */
import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Box } from '@mui/material';
import { fn } from 'storybook/test';
import { STORY_IMAGE_PATH, STORY_VIDEO_PATH } from '../testing/storybook';
import { ShotCard } from './ShotCard';
function CardPreview(args: ComponentProps<typeof ShotCard>) {
  const [selected, setSelected] = useState(args.selected);
  return (
    <Box sx={{ maxWidth: 340 }}>
      <ShotCard {...args} selected={selected} onSelect={() => setSelected(!selected)} />
    </Box>
  );
}
const meta = {
  title: 'Общие/Карточка плана',
  component: ShotCard,
  render: (args) => <CardPreview {...args} />,
  args: {
    shot: {
      id: 'M01',
      title: 'Вечер у воды — длинное название для проверки обрезки',
      start: 0,
      end: 8,
      lipsync: false,
      state: 'completed',
      stageLabel: 'Принятый монтаж сохранён.'
    },
    imagePath: STORY_IMAGE_PATH,
    videoPath: null,
    selected: false,
    onSelect: fn()
  }
} satisfies Meta<typeof ShotCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Image: Story = { name: 'Изображение и выбор' };
export const Video: Story = { name: 'Видео при наведении', args: { videoPath: STORY_VIDEO_PATH } };
export const Empty: Story = { name: 'Пустое медиа', args: { imagePath: null, videoPath: null } };
export const Missing: Story = { name: 'Отсутствующее медиа', args: { imagePath: '/mock/нет изображения.png' } };
export const Stale: Story = {
  name: 'Прежний материал сохранён',
  args: {
    shot: { ...meta.args.shot, state: 'stale', stageLabel: 'Постановка изменилась: требуется новое производство.' },
    selected: true,
    videoPath: STORY_VIDEO_PATH
  }
};
