/** Все статусы используют рабочую палитру; цвет дополняет текст. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@mui/material';
import type { ProjectState } from '@shared/types';
import { StateChip } from './StateChip';
const states: ProjectState[] = ['invalid', 'empty', 'sourced', 'timed', 'scripted', 'in_production', 'complete'];
const meta = { title: 'Общие/Статусы проекта', component: StateChip, args: { state: 'in_production' } } satisfies Meta<typeof StateChip>;
export default meta;
type Story = StoryObj<typeof meta>;
export const One: Story = { name: 'Один статус' };
export const All: Story = {
  name: 'Все статусы',
  render: () => (
    <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1}>
      {states.map((state) => (
        <StateChip key={state} state={state} />
      ))}
    </Stack>
  )
};
