/** Черновик типа не пропадает от Escape и фона; явная отмена отбрасывает его. */
import { useState, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
import type { KindForm } from '../types';
import { ReferenceKindDialog } from './ReferenceKindDialog';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';

function Preview(): ReactElement {
  const [value, setValue] = useState<KindForm | null>(null);
  return (
    <>
      <Button startIcon={<AddIcon />} onClick={() => setValue({ label: '', id: '', dir: '' })}>
        {sourcesTexts.addKind}
      </Button>
      <ReferenceKindDialog value={value} onChange={setValue} onClose={() => setValue(null)} onAdd={() => setValue(null)} />
    </>
  );
}
const meta = {
  title: 'Исходники/Новый тип референса',
  component: ReferenceKindDialog,
  args: { value: null, onChange: fn(), onClose: fn(), onAdd: fn() },
  render: () => <Preview />
} satisfies Meta<typeof ReferenceKindDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProtectedDraft: Story = {
  name: 'Черновик типа — только явная отмена',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const open = canvas.getByRole('button', { name: sourcesTexts.addKind });
    await userEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: sourcesTexts.newKind });
    const fields = within(dialog);
    await userEvent.type(fields.getByRole('textbox', { name: commonTexts.label }), 'Животные');
    await userEvent.clear(fields.getByRole('textbox', { name: commonTexts.code }));
    await userEvent.type(fields.getByRole('textbox', { name: commonTexts.code }), 'animals');
    await userEvent.type(fields.getByRole('textbox', { name: sourcesTexts.kindDirectory }), 'animals');
    await expectImplicitCloseBlocked(dialog, async () => {
      await expect(fields.getByRole('textbox', { name: commonTexts.label })).toHaveValue('Животные');
      await expect(fields.getByRole('textbox', { name: commonTexts.code })).toHaveValue('animals');
      await expect(fields.getByRole('textbox', { name: sourcesTexts.kindDirectory })).toHaveValue('animals');
    });
    await userEvent.click(fields.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(open).toHaveFocus());
    await userEvent.click(open);
    const reopened = within(await screen.findByRole('dialog', { name: sourcesTexts.newKind }));
    await expect(reopened.getByRole('textbox', { name: commonTexts.label })).toHaveValue('');
    await userEvent.type(reopened.getByRole('textbox', { name: commonTexts.label }), 'Животные');
    await userEvent.click(reopened.getByRole('button', { name: commonTexts.add }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
