/** Возврат к черновику безопасен: закрытие подтверждения не заменяет текущий монтаж. */
import { useState } from 'react';
import { Button, Typography } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { montageTexts } from '@shared/texts/montage';
import { MontageDiscardDialog } from './MontageDiscardDialog';
function DiscardStory() {
  const [open, setOpen] = useState(false);
  const [replaced, setReplaced] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть другую пробу</Button>
      <Typography>{replaced ? 'Монтаж заменён.' : 'Несохранённый монтаж сохранён в редакторе.'}</Typography>
      <MontageDiscardDialog
        open={open}
        onClose={() => setOpen(false)}
        onContinue={() => {
          setReplaced(true);
          setOpen(false);
        }}
      />
    </>
  );
}
const meta = { title: 'Монтаж/Замена черновика', component: DiscardStory, tags: ['!autodocs'] } satisfies Meta<typeof DiscardStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WarningAndReturn: Story = {
  name: 'Предупреждение и возврат без потери правок',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть другую пробу' }));
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('alert')).toHaveTextContent(montageTexts.replaceWarning);
    dialog.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Несохранённый монтаж сохранён в редакторе.')).toBeInTheDocument();
  }
};
