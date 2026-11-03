/** Настоящий диалог открывается кнопкой; подтверждение и отмена меняют только состояние демонстрации. */
import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Stack } from '@mui/material';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { expectImplicitCloseBlocked } from '../testing/dialogStories';
import { commonTexts } from '@shared/texts/common';
import { storyAccess } from '../testing/commonStories';
import type { StoryOptions } from '../testing/storybook';
import { ActionButton } from './ActionButton';
import { ConfirmationDialog } from './ConfirmationDialog';
function DialogPreview(args: ComponentProps<typeof ConfirmationDialog>) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState('Решение ещё не принято.');
  return (
    <Stack spacing={2} alignItems="flex-start">
      <ActionButton variant="contained" onClick={() => setOpen(true)}>
        Открыть подтверждение
      </ActionButton>
      <Alert severity="info">{result}</Alert>
      <ConfirmationDialog
        {...args}
        open={open}
        onClose={() => {
          setOpen(false);
          setResult('Отменено.');
        }}
        onConfirm={() => {
          setOpen(false);
          setResult('Подтверждено в демонстрации.');
        }}
      />
    </Stack>
  );
}
const meta: Meta<typeof ConfirmationDialog> = {
  title: 'Общие/Подтверждение',
  component: ConfirmationDialog,
  render: (args) => <DialogPreview {...args} />,
  args: {
    open: false,
    title: 'Принять результат?',
    description: 'Проверьте предпросмотр. Предыдущий комплект сохранится в истории.',
    confirmLabel: commonTexts.accept,
    onClose: fn(),
    onConfirm: fn(),
    cancelAutoFocus: true
  },
  parameters: { songframe: { app: { aiAccess: storyAccess, agentProvider: 'codex' } } satisfies StoryOptions }
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Local: Story = { name: 'Обычное подтверждение' };
export const Agent: Story = { name: 'Подтверждение агента', args: { confirmAgent: { provider: 'codex' }, confirmLabel: 'Передать агенту' } };
export const Blocked: Story = {
  name: 'Подтверждение недоступно',
  args: { confirmDisabled: true, confirmDisabledReason: 'Предпросмотр устарел. Соберите результат заново.' }
};
export const Pending: Story = {
  name: 'Нельзя закрыть во время записи',
  args: {
    confirmDisabled: true,
    confirmDisabledReason: commonTexts.waitForSaving,
    cancelDisabled: true,
    cancelDisabledReason: commonTexts.waitForSaving,
    closeDisabled: true,
    description: 'Демонстрация блокировки во время записи. Для выхода переключите историю.'
  }
};

export const ExplicitCancellation: Story = {
  name: 'Подготовленный запрос · закрытие только явной отменой',
  tags: ['ci'],
  args: { explicitCancelOnly: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть подтверждение' }));
    const dialog = await screen.findByRole('dialog');
    await expectImplicitCloseBlocked(dialog);
    await expect(canvas.getByText('Решение ещё не принято.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Отменено.')).toBeInTheDocument();
  }
};
export const HarmlessEscape: Story = {
  name: 'Обычное подтверждение · Escape отменяет без потерь',
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Открыть подтверждение' }));
    const dialog = await screen.findByRole('dialog');
    dialog.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
