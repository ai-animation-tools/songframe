/** Состояния обычного действия и доступная с клавиатуры причина блокировки. */
import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Stack } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { commonTexts } from '@shared/texts/common';
import { ActionButton } from './ActionButton';

function ActionPreview(args: ComponentProps<typeof ActionButton>) {
  const [count, setCount] = useState(0);
  return (
    <Stack spacing={2} alignItems="flex-start">
      <ActionButton {...args} onClick={() => setCount(count + 1)} />
      <Alert severity="info">Нажатий: {count}</Alert>
    </Stack>
  );
}
const meta = {
  title: 'Общие/Кнопка действия',
  component: ActionButton,
  render: (args) => <ActionPreview {...args} />,
  args: { children: commonTexts.save, variant: 'contained', startIcon: <SaveIcon /> }
} satisfies Meta<typeof ActionButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = { name: 'Доступна' };
export const Busy: Story = { name: 'Выполняется', args: { disabled: true, disabledReason: commonTexts.waitForSaving } };
export const LongReason: Story = {
  name: 'Длинная причина и фокус',
  args: {
    disabled: true,
    disabledReason:
      'Источник изменился после сборки предпросмотра. Проверьте принятый материал, затем соберите и просмотрите новый результат перед заменой комплекта.'
  }
};
