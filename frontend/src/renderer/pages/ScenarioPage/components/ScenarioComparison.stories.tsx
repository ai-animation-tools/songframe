/** Полный диалог показывает реальные доменные блоки сравнения и влияние доработки на соседний план. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { scenarioTexts } from '@shared/texts/scenario';
import { ScenarioComparisonStory, scenarioWorkflowOptions } from '../../../testing/scenarioWorkflowStories';

const meta = {
  title: 'Сценарий/Сравнение предложения',
  component: ScenarioComparisonStory,
  tags: ['!autodocs'],
  parameters: { songframe: scenarioWorkflowOptions('ready'), controls: { disable: true } }
} satisfies Meta<typeof ScenarioComparisonStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TreatmentAndCast: Story = {
  name: 'Кастинг и трактовка · изменения, новое место и отсутствие изображения',
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
    // Dialog сначала монтирует содержимое с нулевой прозрачностью; ждём видимое состояние, а не только DOM.
    await waitFor(() => expect(dialog.getByText('Для «Старые ворота» ещё нет изображения. Перед подробным сценарием добавьте референс.')).toBeVisible());
    await expect(dialog.getByText('Герой возвращается к старым воротам и замечает свет в знакомом окне.')).toBeVisible();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 0. Отклонений: 0.');
    await userEvent.click(screen.getByRole('button', { name: 'Открыть сравнение повторно' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Предложение для сценария/ })).toBeVisible());
  }
};
export const Scenes: Story = {
  name: 'Подробный сценарий · постановка, границы и неизменённый M02',
  parameters: { songframe: scenarioWorkflowOptions('scenes') },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
    await waitFor(() => expect(dialog.getByText('Герой останавливается под дождём и смотрит на окно.')).toBeVisible());
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.proposal.applyScenes }));
    const confirmation = within(await screen.findByRole('dialog', { name: `${scenarioTexts.proposal.applyScenes}?` }));
    await userEvent.click(confirmation.getByRole('button', { name: commonTexts.apply }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 1. Отклонений: 0. Обновлений редакторов: 1.');
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
    await expect(screen.getByTestId('scenario-scene-M01')).toHaveTextContent(
      'M01: 0–120. Плавное приближение, средний план. Герой останавливается под дождём и смотрит на окно.'
    );
    await expect(screen.getByTestId('scenario-scene-M02')).toHaveTextContent('M02: 120–240. Крупный план. Герой поворачивает голову к окну.');
    await expect(screen.getByTestId('scenario-cast')).toHaveTextContent('Сохранённые сущности: hero.');
    await expect(screen.getByTestId('scenario-review')).toHaveTextContent('Сценарий требует пересмотра: нет.');
  }
};
export const ReviseContinuity: Story = {
  name: 'Доработка M01 · изменение состояния перед M02',
  parameters: { songframe: scenarioWorkflowOptions('revise') },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
    await waitFor(() => expect(dialog.getByText(scenarioTexts.comparison.stateBefore({ shot: 'M02' }))).toBeVisible());
    await expect(dialog.getByText(scenarioTexts.comparison.allowedTargets({ ids: ['M01'] }))).toBeVisible();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.proposal.discard }));
    const confirmation = within(await screen.findByRole('dialog', { name: `${scenarioTexts.proposal.discard}?` }));
    await userEvent.click(confirmation.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${scenarioTexts.proposal.discard}?` })).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 0. Отклонений: 0.');
  }
};
