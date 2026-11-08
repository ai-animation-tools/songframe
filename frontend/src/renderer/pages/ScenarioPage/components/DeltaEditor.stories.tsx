/** Выбор сущности и пустого поля остаётся локальным и не создаёт пробелов в state_changes. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack, Typography } from '@mui/material';
import { expect, userEvent, within } from 'storybook/test';
import { scenarioTexts } from '@shared/texts/scenario';
import { componentsTexts } from '@shared/texts/components';
import type { StateDelta } from '@shared/types';
import { DeltaEditor } from './DeltaEditor';

function Preview() {
  const [delta, setDelta] = useState<StateDelta>({});
  return (
    <Stack spacing={2}>
      <DeltaEditor
        phase="after"
        reveal={null}
        delta={delta}
        baseline={{ hero: { coat: 'сухая' } }}
        entities={[
          { id: 'hero', label: 'Герой' },
          { id: 'neighbor', label: 'Сосед' }
        ]}
        propertiesOf={() => [
          { key: 'coat', label: 'Куртка' },
          { key: 'helmet', label: 'Шлем' }
        ]}
        onChange={(entity, value) =>
          setDelta((current) => {
            const next = { ...current };
            if (Object.keys(value).length) next[entity] = value;
            else delete next[entity];
            return next;
          })
        }
      />
      <Typography data-testid="delta-value">{JSON.stringify(delta)}</Typography>
    </Stack>
  );
}
const meta = { title: 'Сценарий/Изменения состояния', component: Preview } satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EmptyEntityAndFields: Story = {
  name: 'Добавить сущность и пустое поле без изменения документа',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const texts = componentsTexts.stateEditor;
    await userEvent.click(canvas.getByRole('combobox', { name: scenarioTexts.delta.entity }));
    await userEvent.click(await screen.findByRole('option', { name: 'Герой' }));
    await userEvent.click(canvas.getByRole('button', { name: scenarioTexts.delta.addEntity }));
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toHaveAttribute('placeholder', 'сухая');
    await expect(canvas.queryByRole('combobox', { name: 'Шлем' })).not.toBeInTheDocument();
    await expect(canvas.getByTestId('delta-value')).toHaveTextContent('{}');
    await userEvent.click(canvas.getByRole('combobox', { name: texts.dictionaryProperty }));
    await userEvent.click(await screen.findByRole('option', { name: 'Шлем' }));
    await userEvent.click(canvas.getByRole('button', { name: texts.addDictionaryProperty }));
    await expect(canvas.getByRole('combobox', { name: 'Шлем' })).toHaveFocus();
    await expect(canvas.getByTestId('delta-value')).toHaveTextContent('{}');
    await userEvent.type(canvas.getByRole('combobox', { name: 'Шлем' }), 'красный');
    await expect(canvas.getByTestId('delta-value')).toHaveTextContent('"hero":{"helmet":"красный"}');
    await expect(canvas.getByRole('combobox', { name: 'Куртка' })).toHaveAttribute('placeholder', 'сухая');
  }
};
