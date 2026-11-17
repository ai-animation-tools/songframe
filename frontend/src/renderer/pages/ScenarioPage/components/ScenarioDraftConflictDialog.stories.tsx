/** Разрешение черновиков проверяется до продолжения; демонстрационная модель не запускает агента. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { scenarioTexts } from '@shared/texts/scenario';
import { SCENARIO_CONFLICT_ERROR, SCENARIO_DRAFT, ScenarioDraftConflictStory } from '../../../testing/scenarioSaveStories';

const meta = {
  title: 'Сценарий/Сохранение/Конфликт черновиков',
  component: ScenarioDraftConflictStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ScenarioDraftConflictStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ScenarioDraftConflictStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Save: Story = {
  name: 'Сохранить и продолжить',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByText(scenarioTexts.drafts.changed)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: нет.');
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 1. Запусков агента: 0.');
  }
};

export const Discard: Story = {
  name: 'Отменить правки и продолжить',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.drafts.discardAndContinue }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('textbox', { name: 'Черновик сценария' })).toHaveValue('Олег открывает калитку.');
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent('Олег открывает калитку.');
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: нет.');
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 1. Запусков агента: 0.');
  }
};

export const CancelAndEscape: Story = {
  name: 'Вернуться к редактору и Escape · черновик сохранён',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.drafts.returnToEditor }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('textbox', { name: 'Черновик сценария' })).toHaveValue(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: да.');
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 0.');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть конфликт черновиков' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: да.');
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 0.');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть конфликт черновиков' }));
    await expect(await screen.findByRole('dialog')).toBeInTheDocument();
  }
};

export const Busy: Story = {
  name: 'Занято · все решения и Escape заблокированы',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    for (const name of [scenarioTexts.drafts.returnToEditor, scenarioTexts.drafts.discardAndContinue, scenarioTexts.drafts.saveAndContinue]) {
      await expect(within(dialog).getByRole('button', { name })).toBeDisabled();
    }
    await userEvent.keyboard('{Escape}');
    await expect(dialog).toBeInTheDocument();
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 0.');
  }
};

export const SaveFailure: Story = {
  name: 'Ошибка сохранения · черновик остаётся для повтора',
  args: { failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await screen.findByText(SCENARIO_CONFLICT_ERROR);
    await expect(dialog).toBeInTheDocument();
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: да.');
    await expect(canvas.getByTestId('saved-scenes')).not.toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 0.');
    await userEvent.click(within(dialog).getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('saved-scenes')).toHaveTextContent(SCENARIO_DRAFT);
    await expect(canvas.getByTestId('dirty-state')).toHaveTextContent('Несохранённые правки: нет.');
    await expect(canvas.getByTestId('continue-count')).toHaveTextContent('Продолжений: 1.');
    await expect(screen.queryByText(SCENARIO_CONFLICT_ERROR)).not.toBeInTheDocument();
  }
};
