/** Общий редактор проверяется с отдельными снимками формы и файла, без IPC и настоящего проекта. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Box, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RefreshIcon from '@mui/icons-material/Refresh';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { componentsTexts } from '@shared/texts/components';
import { commonTexts } from '@shared/texts/common';
import { ActionButton } from './ActionButton';
import { StateEditor } from './StateEditor';

const texts = componentsTexts.stateEditor;
const catalog = [
  { key: 'coat', label: 'Куртка', hint: 'Состояние куртки', values: ['красная', 'зелёная'] },
  { key: 'pose', label: 'Поза' },
  { key: 'helmet', label: 'Шлем' }
];
function Preview({ scene = false, empty = false }: { scene?: boolean; empty?: boolean }) {
  const initial: Record<string, string | null> = scene ? { coat: 'мокрая', scar: 'на щеке' } : empty ? {} : { coat: 'синяя', scar: 'на щеке' };
  const [saved, setSaved] = useState<Record<string, string | null>>(initial);
  const [value, setValue] = useState<Record<string, string | null>>(initial);
  const [epoch, setEpoch] = useState(0);
  return (
    <Stack spacing={2}>
      <StateEditor
        resetKey={saved}
        key={epoch}
        properties={catalog}
        value={value}
        baseline={scene ? { coat: 'сухая', pose: 'сидит' } : {}}
        allowRemove={scene}
        onChange={setValue}
      />
      <Box>
        <ActionButton
          startIcon={<SaveIcon />}
          onClick={() => {
            setSaved(structuredClone(value));
          }}
        >
          {commonTexts.save}
        </ActionButton>
        <ActionButton
          startIcon={<RefreshIcon />}
          onClick={() => {
            setValue(structuredClone(saved));
            setEpoch((current) => current + 1);
          }}
        >
          Открыть сохранённое состояние
        </ActionButton>
      </Box>
      <Typography data-testid="state-draft">{JSON.stringify(value)}</Typography>
      <Typography data-testid="state-saved">{JSON.stringify(saved)}</Typography>
    </Stack>
  );
}
const meta = { title: 'Общие/Поля состояния', component: Preview, args: { scene: false, empty: false } } satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

async function confirm(canvasElement: HTMLElement, action: string, confirmLabel: string): Promise<void> {
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(within(canvasElement).getByRole('button', { name: action }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}
export const EmptySelection: Story = {
  name: 'Пустое состояние · выбор поля не создаёт данных',
  tags: ['ci'],
  args: { empty: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await expect(canvas.queryByRole('combobox', { name: 'Куртка' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('combobox', { name: texts.dictionaryProperty }));
    await userEvent.click(await screen.findByRole('option', { name: 'Поза' }));
    await userEvent.click(canvas.getByRole('button', { name: texts.addDictionaryProperty }));
    await expect(canvas.getByRole('combobox', { name: 'Поза' })).toHaveFocus();
    await expect(canvas.getByTestId('state-draft')).toHaveTextContent('{}');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(canvas.queryByRole('combobox', { name: 'Поза' })).not.toBeInTheDocument();
    await expect(canvas.getByTestId('state-saved')).toHaveTextContent('{}');
  }
};
export const LocalRemoval: Story = {
  name: 'Словарное и своё поле · удалить, вернуть, сохранить',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await confirm(canvasElement, texts.removeLocalProperty({ label: 'Куртка' }), texts.removeLocal);
    await expect(canvas.queryByRole('combobox', { name: 'Куртка' })).not.toBeInTheDocument();
    await expect(canvas.getByTestId('state-saved')).toHaveTextContent('синяя');
    await expect(canvas.getByRole('combobox', { name: 'scar' })).toHaveValue('на щеке');
    await userEvent.click(canvas.getByRole('combobox', { name: texts.dictionaryProperty }));
    await userEvent.click(await screen.findByRole('option', { name: 'Куртка' }));
    await userEvent.click(canvas.getByRole('button', { name: texts.addDictionaryProperty }));
    const coat = canvas.getByRole('combobox', { name: 'Куртка' });
    await userEvent.click(coat);
    await userEvent.click(await screen.findByRole('option', { name: 'красная' }));
    await expect(coat).toHaveValue('красная');
    await expect(canvas.getByTestId('state-draft')).toHaveTextContent('красная');
    await userEvent.clear(coat);
    await expect(coat).toHaveValue('');
    await userEvent.type(coat, 'зелёная');
    await confirm(canvasElement, texts.removeLocalProperty({ label: 'scar' }), texts.removeLocal);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённое состояние' }));
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toHaveValue('зелёная');
    await expect(canvas.queryByRole('combobox', { name: 'scar' })).not.toBeInTheDocument();
    await userEvent.type(canvas.getByRole('textbox', { name: texts.customKey }), 'hat');
    await userEvent.click(canvas.getByRole('button', { name: texts.addCustomProperty }));
    await expect(canvas.getByRole('combobox', { name: 'hat' })).toHaveFocus();
    await expect(canvas.getByTestId('state-draft')).not.toHaveTextContent('hat');
  }
};
export const Inheritance: Story = {
  name: 'Сценарий · убрать изменение, снять свойство и вернуть наследование',
  tags: ['ci'],
  args: { scene: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await confirm(canvasElement, texts.undoProperty({ label: 'Куртка' }), texts.undo);
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toHaveAttribute('placeholder', 'сухая');
    await expect(canvas.getByTestId('state-draft')).not.toHaveTextContent('coat');
    await confirm(canvasElement, texts.removeProperty({ label: 'Куртка' }), texts.remove);
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toBeDisabled();
    await expect(canvas.getByTestId('state-draft')).toHaveTextContent('"coat":null');
    await userEvent.click(canvas.getByRole('button', { name: texts.restoreProperty({ label: 'Куртка' }) }));
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toBeEnabled();
    await expect(canvas.getByTestId('state-draft')).not.toHaveTextContent('coat');
    await expect(canvas.getByRole('combobox', { name: 'Поза' })).toHaveAttribute('placeholder', 'сидит');
  }
};
