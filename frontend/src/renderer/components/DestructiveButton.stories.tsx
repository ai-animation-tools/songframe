/** Подтверждение удаления работает с локальным счётчиком и сохраняет отмену без последствий. */
import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Stack } from '@mui/material';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { DestructiveButton } from './DestructiveButton';
function DeletePreview(args: ComponentProps<typeof DestructiveButton>) {
  const [removed, setRemoved] = useState(false);
  return (
    <Stack spacing={2} alignItems="flex-start">
      <DestructiveButton
        {...args}
        disabled={args.disabled || removed}
        disabledReason={removed ? 'Демонстрационный объект уже удалён.' : args.disabledReason}
        onConfirm={() => setRemoved(true)}
      />
      <Alert severity="info">{removed ? 'Объект удалён в демонстрации.' : 'Объект сохранён.'}</Alert>
    </Stack>
  );
}
const meta: Meta<typeof DestructiveButton> = {
  title: 'Общие/Удаление',
  component: DestructiveButton,
  render: (args) => <DeletePreview {...args} />,
  args: { label: 'Удалить попытку', description: 'Удаляется только демонстрационный объект. Отмена сохранит его.', onConfirm: fn() }
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirmation: Story = { name: 'Отмена и подтверждение' };
export const Blocked: Story = { name: 'Удаление недоступно', args: { disabled: true, disabledReason: 'Дождитесь завершения текущей операции.' } };

export const VisibleConsequences: Story = {
  name: 'Последствия изменения состояния · отдельный Alert',
  tags: ['ci'],
  args: { descriptionSeverity: 'warning' },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Удалить попытку' }));
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('alert')).toHaveTextContent('Удаляется только демонстрационный объект. Отмена сохранит его.');
  }
};

// Фокус после отмены с клавиатуры — рамка цвета кнопки: фон за подписью не меняется, и axe проверяет контраст подписи.
export const KeyboardCancelFocus: Story = {
  name: 'Отмена с клавиатуры · фокус рамкой без заливки',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const button = within(canvasElement).getByRole('button', { name: 'Удалить попытку' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(button).toHaveFocus();
    await expect(button).toHaveClass('Mui-focusVisible');
    const style = getComputedStyle(button);
    await expect(style.outlineStyle).toBe('solid');
    await expect(style.outlineColor).toBe(style.color);
    await expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await expect(button.querySelector('.MuiTouchRipple-ripplePulsate')).toBeNull();
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Объект сохранён.');
  }
};
