/** Окно перед описанием плана: выбор героев с образами при избытке над пределом модели. Ответ виден в памяти истории. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert } from '@mui/material';
import type { DescriptionLooksQuestion } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { storyAccess } from '../../../testing/commonStories';
import type { StoryOptions } from '../../../testing/storybook';
import { SavedLooksBeforeDialog } from './SavedLooksBeforeDialog';

const QUESTION: DescriptionLooksQuestion = {
  model: 'test-video',
  limit: 2,
  without: [],
  choose: [
    { code: 'mira', name: 'Мира', kind: 'character', status: 'ready' },
    { code: 'lev', name: 'Лев', kind: 'character', status: 'stale' },
    { code: 'kite', name: 'Воздушный змей', kind: 'prop', status: 'ready' }
  ]
};

function DialogStory({ agent }: { agent: boolean }) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState('Ответа нет.');
  return (
    <>
      <Alert severity="info" role="status">
        {result}
      </Alert>
      <SavedLooksBeforeDialog
        question={open ? QUESTION : null}
        agent={agent}
        onOpenReference={() => undefined}
        onContinue={(looks) => {
          setOpen(false);
          setResult(looks ? `Выбраны: ${looks.join(', ')}` : 'Продолжено без выбора.');
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: 'Производство/Образы героев/Перед описанием',
  component: DialogStory,
  args: { agent: true },
  parameters: { songframe: { app: { aiAccess: storyAccess, agentProvider: 'codex' } } satisfies StoryOptions }
} satisfies Meta<typeof DialogStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseBeforeAgent: Story = {
  tags: ['ci'],
  name: 'Образов больше предела · персонажи отмечены первыми, лишний выбор блокирует продолжение',
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = within(await body.findByRole('dialog', { name: savedLooksTexts.beforeTitle }));
    await expect(dialog.getByRole('checkbox', { name: 'Мира' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Лев' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Воздушный змей' })).not.toBeChecked();
    await expect(dialog.getByText(savedLooksTexts.beforeChosen({ count: 2, limit: 2 }), { exact: false })).toBeVisible();
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Воздушный змей' }));
    // Кнопка при блокировке оборачивается подсказкой: элемент ищется заново после каждой смены выбора.
    const proceed = () => dialog.getByRole('button', { name: savedLooksTexts.beforeContinue });
    await waitFor(() => expect(proceed()).toBeDisabled());
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Лев' }));
    await expect(dialog.getByRole('checkbox', { name: 'Лев' })).not.toBeChecked();
    await waitFor(() => expect(proceed()).toBeEnabled());
    await userEvent.click(proceed());
    await waitFor(() => expect(body.getByRole('status')).toHaveTextContent('Выбраны: mira, kite'));
  }
};

export const InfoBeforeOwn: Story = {
  name: 'Своё описание · выбора нет, окно говорит, сколько меток поставить',
  args: { agent: false },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = within(await body.findByRole('dialog', { name: savedLooksTexts.beforeTitle }));
    await expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    await expect(dialog.getByText(savedLooksTexts.beforeOver({ model: 'test-video', limit: 2, count: 3 }))).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: savedLooksTexts.beforeContinue }));
    await waitFor(() => expect(body.getByRole('status')).toHaveTextContent('Продолжено без выбора.'));
  }
};
