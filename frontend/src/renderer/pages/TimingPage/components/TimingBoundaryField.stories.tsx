/** Управляемый ручной ввод сохраняет точный текст, пока страница не проверит его при сохранении. */
import { useState, type ReactElement } from 'react';
import { Button, Checkbox, FormControlLabel, Stack } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { timingTexts } from '@shared/texts/timing';
import { TimingBoundaryField } from './TimingBoundaryField';

function ManualBoundaryFields(): ReactElement {
  const [values, setValues] = useState({ start: 12, end: 2.9 });
  const [manualMode, setManualMode] = useState(true);
  const [drafts, setDrafts] = useState<Partial<Record<'start' | 'end', string>>>({});
  const update = (field: 'start' | 'end', text: string): void => {
    setDrafts((current) => ({ ...current, [field]: text }));
    if (manualMode) setValues((current) => ({ ...current, [field]: text.trim() ? Number(text) : Number.NaN }));
  };
  return (
    <Stack spacing={2} sx={{ maxWidth: 320 }}>
      <FormControlLabel control={<Checkbox checked={manualMode} onChange={(_, checked) => setManualMode(checked)} />} label={timingTexts.manualMode} />
      <Button
        onClick={() => {
          setValues((current) => ({ ...current, start: 1.5 }));
          setDrafts((current) => ({ ...current, start: undefined }));
        }}
      >
        Изменить начало с волны
      </Button>
      <TimingBoundaryField
        manualMode={manualMode}
        value={values.start}
        draft={drafts.start}
        onDraftChange={(text) => update('start', text)}
        min={0}
        max={values.end - 0.3}
        label={timingTexts.lineStart({ id: 1 })}
        onCommit={(start) => setValues((current) => ({ ...current, start }))}
      />
      <TimingBoundaryField
        manualMode={manualMode}
        value={values.end}
        draft={drafts.end}
        onDraftChange={(text) => update('end', text)}
        min={values.start + 0.3}
        max={30}
        label={timingTexts.lineEnd({ id: 1 })}
        onCommit={(end) => setValues((current) => ({ ...current, end }))}
      />
    </Stack>
  );
}

const meta = {
  title: 'Тайминги/Поле границы',
  component: ManualBoundaryFields,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof ManualBoundaryFields>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ManualRawInput: Story = {
  name: 'Ручной ввод · начало после конца · точный черновик',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const start = canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 1 }) });
    const end = canvas.getByRole('textbox', { name: timingTexts.lineEnd({ id: 1 }) });
    await expect(start).toHaveValue('12');
    await expect(end).toHaveValue('2.9');
    await expect(start).not.toHaveAttribute('min');
    await expect(start).not.toHaveAttribute('max');
    await expect(start).toHaveAttribute('inputmode', 'decimal');
    await userEvent.clear(start);
    await userEvent.type(start, '16');
    await expect(start).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(start).toHaveValue('16');
    await expect(end).toHaveValue('2.9');
    await userEvent.clear(start);
    await userEvent.tab();
    await expect(start).toHaveValue('');
    await userEvent.type(start, 'не время{Enter}');
    await expect(start).toHaveValue('не время');
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(canvas.getByRole('checkbox', { name: timingTexts.manualMode }));
    await expect(canvas.getByRole('textbox', { name: timingTexts.lineStart({ id: 1 }) })).toHaveValue('не время');
    await expect(start).not.toHaveAttribute('min');
    await expect(start).not.toHaveAttribute('max');
    // После выхода из режима выполняем настоящий цикл focus → blur: черновик остаётся до Save.
    await userEvent.click(start);
    await userEvent.tab();
    await expect(start).not.toHaveFocus();
    await expect(start).toHaveValue('не время');
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(start);
    await userEvent.keyboard('{Enter}');
    await expect(start).toHaveValue('не время');
    await userEvent.click(canvas.getByRole('checkbox', { name: timingTexts.manualMode }));
    await expect(start).toHaveValue('не время');
    await userEvent.clear(start);
    await userEvent.type(start, '-5{Enter}');
    await expect(start).toHaveValue('-5');
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    // Пересчёт соседнего ограничения не подменяет уже введённую строку родительскими числами.
    await userEvent.clear(end);
    await userEvent.type(end, '1{Enter}');
    await expect(start).toHaveValue('-5');
    await expect(end).toHaveValue('1');
    await userEvent.click(canvas.getByRole('checkbox', { name: timingTexts.manualMode }));
    await userEvent.click(canvas.getByRole('button', { name: 'Изменить начало с волны' }));
    await expect(canvas.getByRole('spinbutton', { name: timingTexts.lineStart({ id: 1 }) })).toHaveValue(1.5);
  }
};
