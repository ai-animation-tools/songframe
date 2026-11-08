/** Истории проходят настоящий hook, подтверждения и опрос без запуска программ или чтения проекта. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { scenarioTexts } from '@shared/texts/scenario';
import { ScenarioWorkflowStory, scenarioWorkflowOptions, SCENARIO_APPLY_CONFLICT, SCENARIO_APPLY_FAILURE } from '../../../testing/scenarioWorkflowStories';

const meta = {
  title: 'Сценарий/Рабочая панель',
  component: ScenarioWorkflowStory,
  // Диалоги переводят фокус; отдельный Canvas изолирует их от соседних историй.
  tags: ['!autodocs'],
  parameters: { songframe: scenarioWorkflowOptions(), controls: { disable: true } }
} satisfies Meta<typeof ScenarioWorkflowStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
const screenOf = (context: Context) => within(context.canvasElement.ownerDocument.body);
async function ready(context: Context) {
  const screen = screenOf(context);
  await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.createTreatment })).toBeEnabled());
  return screen;
}
async function preview(context: Context) {
  const screen = screenOf(context);
  await userEvent.click(await screen.findByRole('button', { name: scenarioTexts.workflow.reviewProposal }));
  const dialog = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
  // Перевод фокуса MUI должен закончиться до вложенного подтверждения и Escape.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  return dialog;
}
async function confirmApply(context: Context, cancel = false, pass: 'treatment' | 'scenes' = 'treatment') {
  const screen = screenOf(context);
  const dialog = within(screen.getByRole('dialog', { name: /Предложение для сценария/ }));
  const label = pass === 'treatment' ? scenarioTexts.proposal.applyTreatment : scenarioTexts.proposal.applyScenes;
  await userEvent.click(dialog.getByRole('button', { name: label }));
  const confirmation = within(await screen.findByRole('dialog', { name: `${label}?` }));
  await userEvent.click(confirmation.getByRole('button', { name: cancel ? commonTexts.cancel : commonTexts.apply }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: `${label}?` })).not.toBeInTheDocument());
}

export const Preparation: Story = {
  name: 'Подготовка · остановка и завершение через опрос',
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createTreatment }));
    await userEvent.click(await screen.findByRole('button', { name: commonTexts.stop }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1. Применений: 0.'));
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.newProposal }));
    await userEvent.click(await screen.findByRole('button', { name: 'Завершить демонстрационное задание' }));
    await screen.findByRole('button', { name: scenarioTexts.workflow.reviewProposal }, { timeout: 4000 });
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 2. Применений: 0.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 0.');
  }
};
export const InconsistentInputs: Story = {
  name: 'Несогласованные входы · причины и восстановление',
  parameters: { songframe: scenarioWorkflowOptions('inputs') },
  play: async (context) => {
    const screen = screenOf(context);
    await screen.findByText('Нет утверждённой разметки песни.');
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createTreatment })).toBeDisabled();
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await expect(screen.getByRole('button', { name: scenarioTexts.revise.title })).toBeDisabled();
    await expect(screen.queryByRole('button', { name: scenarioTexts.workflow.approveTreatment })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.showAllProblems({ count: 4 }) }));
    await expect(screen.getByText('Кастинг и трактовка требуют повторной проверки после исправления входов.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Согласовать демонстрационные входы' }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment })).toBeEnabled());
    // Исправление входов не утверждает существующую пару автоматически.
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
  }
};
export const Ready: Story = {
  name: 'Готовое предложение · отмена подтверждения и применение',
  parameters: { songframe: scenarioWorkflowOptions('ready') },
  play: async (context) => {
    const screen = await ready(context);
    const dialog = await preview(context);
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.proposal.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 0.');
    await preview(context);
    await confirmApply(context, true);
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 0.');
    await confirmApply(context);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 1.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 1.');
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('замечает свет в знакомом окне');
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.approveScenes })).toBeEnabled();
  }
};
export const SequentialPasses: Story = {
  name: 'Трактовка → сценарий · второй проход сохраняет новую пару',
  parameters: { songframe: scenarioWorkflowOptions('ready') },
  play: async (context) => {
    const screen = await ready(context);
    await preview(context);
    await confirmApply(context);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const logline = screen.getByTestId('scenario-saved').textContent;
    const cast = screen.getByTestId('scenario-cast').textContent;
    await expect(screen.getByTestId('scenario-cast')).toHaveTextContent('hero, gate');
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    await userEvent.click(await screen.findByRole('button', { name: 'Завершить демонстрационное задание' }));
    await screen.findByRole('button', { name: scenarioTexts.workflow.reviewProposal }, { timeout: 4000 });
    await expect(screen.getByTestId('scenario-scene-M01')).toHaveTextContent('Герой подходит к воротам.');
    await preview(context);
    await confirmApply(context, false, 'scenes');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-saved').textContent).toBe(logline);
    await expect(screen.getByTestId('scenario-cast').textContent).toBe(cast);
    await expect(screen.getByTestId('scenario-scene-M01')).toHaveTextContent(
      'M01: 0–120. Плавное приближение, средний план. Герой останавливается под дождём и смотрит на окно.'
    );
    await expect(screen.getByTestId('scenario-scene-M02')).toHaveTextContent('M02: 120–240. Крупный план. Герой поворачивает голову к окну.');
    await expect(screen.getByTestId('scenario-review')).toHaveTextContent('Сценарий требует пересмотра: нет.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 2.');
  }
};
export const Stale: Story = {
  name: 'Устаревшее предложение · просмотр и отклонение',
  parameters: { songframe: scenarioWorkflowOptions('stale') },
  play: async (context) => {
    const screen = await ready(context);
    const dialog = await preview(context);
    await expect(dialog.getByText(scenarioTexts.proposal.sourcesChanged)).toBeVisible();
    await expect(dialog.getByRole('button', { name: scenarioTexts.proposal.applyTreatment })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.proposal.discard }));
    const confirmation = within(await screen.findByRole('dialog', { name: `${scenarioTexts.proposal.discard}?` }));
    await userEvent.click(confirmation.getByRole('button', { name: scenarioTexts.proposal.discardConfirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Применений: 0. Отклонений: 1.');
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
  }
};
export const ApplyConflict: Story = {
  name: 'Конфликт применения · исходники изменились после просмотра',
  parameters: { songframe: scenarioWorkflowOptions('applyConflict') },
  play: async (context) => {
    const screen = await ready(context);
    await preview(context);
    await confirmApply(context);
    const dialog = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
    await expect(await dialog.findByText(SCENARIO_APPLY_CONFLICT)).toBeVisible();
    await waitFor(() => expect(dialog.getByRole('button', { name: scenarioTexts.proposal.applyTreatment })).toBeDisabled());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 0.');
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.proposal.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.newProposal }));
    await expect(await screen.findByRole('button', { name: commonTexts.stop })).toBeEnabled();
  }
};
export const ApplyFailure: Story = {
  name: 'Ошибка записи · повтор применяет сохранённое предложение',
  parameters: { songframe: scenarioWorkflowOptions('applyFailure') },
  play: async (context) => {
    const screen = await ready(context);
    await preview(context);
    await confirmApply(context);
    const dialog = within(screen.getByRole('dialog', { name: /Предложение для сценария/ }));
    await expect(await dialog.findByText(SCENARIO_APPLY_FAILURE)).toBeVisible();
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 0.');
    await confirmApply(context);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0. Применений: 2.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Обновлений редакторов: 1.');
  }
};
export const ReadFailure: Story = {
  name: 'Ошибка чтения · штатный опрос восстанавливает панель',
  parameters: { songframe: scenarioWorkflowOptions('readFailure') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText('Не удалось прочитать сценарий. Восстановите чтение в модели.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Восстановить чтение' }));
    await ready(context);
    await waitFor(() => expect(screen.queryByText('Не удалось прочитать сценарий. Восстановите чтение в модели.')).not.toBeInTheDocument(), { timeout: 4000 });
  }
};
export const ManualApproval: Story = {
  name: 'Ручное согласование · трактовка и сценарий отдельно',
  parameters: { songframe: scenarioWorkflowOptions('manual') },
  play: async (context) => {
    const screen = await ready(context);
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.approveScenes })).toBeEnabled());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Согласований: 1.');
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveScenes }));
    await waitFor(() => expect(screen.queryByRole('button', { name: scenarioTexts.workflow.approveScenes })).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Согласований: 2. Обновлений редакторов: 0.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0. Применений: 0.');
  }
};
export const DraftConflict: Story = {
  name: 'Несохранённые правки · отмена, сохранение и продолжение',
  parameters: { songframe: scenarioWorkflowOptions('drafts') },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    let dialog = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.drafts.returnToEditor }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0.');
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    dialog = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
    await expect(screen.getByTestId('scenario-drafts')).toHaveTextContent('Черновики сохранены');
  }
};
export const Revise: Story = {
  name: 'Доработка M01 · обязательное замечание и выбранный охват',
  parameters: { songframe: scenarioWorkflowOptions('drafts') },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.revise.title }));
    // У рабочего диалога доработки пока нет aria-labelledby: находим единственное открытое окно.
    const dialog = within(await screen.findByRole('dialog'));
    await expect(dialog.getByRole('button', { name: scenarioTexts.revise.prepare })).toBeDisabled();
    await userEvent.type(dialog.getByRole('textbox', { name: scenarioTexts.revise.note }), '  Сохранить свет слева, показать мокрую куртку.  ');
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.revise.prepare }));
    const drafts = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(drafts.getByRole('button', { name: scenarioTexts.drafts.discardAndContinue }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
    await expect(screen.getByTestId('scenario-note')).toHaveTextContent('Отправленное замечание для M01: Сохранить свет слева, показать мокрую куртку.');
    await expect(screen.getByTestId('scenario-drafts')).toHaveTextContent('Черновики сброшены');
  }
};
