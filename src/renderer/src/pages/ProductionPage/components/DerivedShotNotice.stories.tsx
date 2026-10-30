import type { Meta, StoryObj } from '@storybook/react-vite';
import { DerivedShotNotice } from './DerivedShotNotice';

/** Переход использует MemoryRouter витрины и настоящий маршрут выбора плана-источника. */
const meta = {
  title: 'Производство/Производный план/Связь с источником',
  component: DerivedShotNotice,
  args: { source: 'M01' },
  parameters: { songframe: { route: '/project/production?shot=M02' } }
} satisfies Meta<typeof DerivedShotNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Source: Story = { name: 'Ссылка на исходный план' };
export const LongSource: Story = { name: 'Длинный код источника · переносы', args: { source: 'M01.12345678901234567890' } };
