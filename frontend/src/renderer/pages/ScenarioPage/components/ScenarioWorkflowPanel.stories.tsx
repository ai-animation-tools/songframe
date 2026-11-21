/** Истории проходят настоящий hook, подтверждения и опрос без запуска программ или чтения проекта. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
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
/** Кнопка части или сценария открывает подтверждение; согласие в окне запускает агента. */
async function startPass(
  context: Context,
  pass: 'treatment' | 'scenes',
  label: string = pass === 'treatment' ? scenarioTexts.workflow.createTreatment : scenarioTexts.workflow.createScenes
) {
  const screen = screenOf(context);
  await userEvent.click(screen.getByRole('button', { name: label }));
  const confirmation = within(await screen.findByRole('dialog', { name: scenarioTexts.workflow.confirmTitle[pass] }));
  await expect(confirmation.getByText(scenarioTexts.workflow.confirmDescription[pass])).toBeVisible();
  await userEvent.click(
    confirmation.getByRole('button', { name: pass === 'treatment' ? scenarioTexts.workflow.createTreatment : scenarioTexts.workflow.createScenes })
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: scenarioTexts.workflow.confirmTitle[pass] })).not.toBeInTheDocument());
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
    // Отказ от подтверждения ничего не запускает.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createTreatment }));
    const confirmation = within(await screen.findByRole('dialog', { name: scenarioTexts.workflow.confirmTitle.treatment }));
    await userEvent.click(confirmation.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0.');
    await startPass(context, 'treatment');
    await userEvent.click(await screen.findByRole('button', { name: commonTexts.stop }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1. Применений: 0.'));
    await expect(screen.getByTestId('scenario-saved')).toHaveTextContent('Герой возвращается к старым воротам.');
    await startPass(context, 'treatment', scenarioTexts.workflow.newProposal);
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
    await expect(screen.getByText('Кастинг и части требуют повторной проверки после исправления входов.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Согласовать демонстрационные входы' }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment })).toBeEnabled());
    // Исправление входов не утверждает существующую пару автоматически.
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeEnabled());
    await startPass(context, 'scenes');
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
export const NoShots: Story = {
  name: 'Сценарий без планов · без доработки выбранного плана',
  args: { hasShots: false },
  play: async (context) => {
    const screen = await ready(context);
    // Доработка нужна выбранному плану, а планов ещё нет; статус обновляет опрос, отдельной кнопки нет.
    await expect(screen.queryByRole('button', { name: scenarioTexts.revise.title })).not.toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: 'Обновить статус' })).not.toBeInTheDocument();
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeInTheDocument();
  }
};
export const SequentialPasses: Story = {
  name: 'Части → планы · второй проход сохраняет новую пару',
  parameters: { songframe: scenarioWorkflowOptions('ready') },
  play: async (context) => {
    const screen = await ready(context);
    await preview(context);
    await confirmApply(context);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const logline = screen.getByTestId('scenario-saved').textContent;
    const cast = screen.getByTestId('scenario-cast').textContent;
    await expect(screen.getByTestId('scenario-cast')).toHaveTextContent('hero, gate');
    await startPass(context, 'scenes');
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
    await startPass(context, 'treatment', scenarioTexts.workflow.newProposal);
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
    const failure = await dialog.findByText(SCENARIO_APPLY_FAILURE);
    await expect(failure).toBeVisible();
    // Ошибка стоит над кнопками вне прокручиваемого сравнения: её видно при любой прокрутке.
    await expect(failure.closest('.MuiDialogContent-root')).toBeNull();
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
  name: 'Ручное согласование · части и планы отдельно',
  parameters: { songframe: scenarioWorkflowOptions('manual') },
  play: async (context) => {
    const screen = await ready(context);
    // Предупреждение называет фактическую причину и держится до утверждения сценария. Правка разметки и кастинга сняла и
    // утверждение пары: предупреждение называет оба шага по порядку — пару, затем сценарий, — и ведёт на страницу кастинга.
    const warning = scenarioTexts.workflow.scenesNeedReview(['timing', 'cast'], 'pair');
    const alert = screen.getAllByRole('alert').find((item) => item.textContent === warning);
    await expect(alert).toBeVisible();
    await expect(warning).toContain('разметка песни, кастинг');
    await expect(within(alert!).getByRole('link', { name: `«${navigationTexts.pages.cast}»` })).toBeVisible();
    await expect(warning).toContain(`«${scenarioTexts.workflow.approveTreatment}», затем «${scenarioTexts.workflow.approveScenes}»`);
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveTreatment }));
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.workflow.approveScenes })).toBeEnabled());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Согласований: 1.');
    // Кнопка утверждения доступна: предупреждение называет шаг, который его снимает.
    const withApprove = scenarioTexts.workflow.scenesNeedReview(['timing', 'cast'], 'scenes');
    await expect(withApprove).toContain(`«${scenarioTexts.workflow.approveScenes}»`);
    await waitFor(() => expect(screen.getAllByRole('alert').find((item) => item.textContent === withApprove)).toBeVisible());
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.approveScenes }));
    await waitFor(() => expect(screen.queryByRole('button', { name: scenarioTexts.workflow.approveScenes })).not.toBeInTheDocument());
    await expect(screen.queryAllByRole('alert').find((item) => item.textContent === withApprove)).toBeUndefined();
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Согласований: 2. Обновлений редакторов: 0.');
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0. Применений: 0.');
  }
};
export const DraftConflict: Story = {
  name: 'Несохранённые правки · отмена, сохранение и продолжение',
  parameters: { songframe: scenarioWorkflowOptions('drafts') },
  play: async (context) => {
    const screen = await ready(context);
    await startPass(context, 'scenes');
    let dialog = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.drafts.returnToEditor }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0.');
    await startPass(context, 'scenes');
    dialog = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
    await expect(screen.getByTestId('scenario-drafts')).toHaveTextContent('Черновики сохранены');
  }
};
export const AcceptedShots: Story = {
  name: 'Принятый M01 · подтверждение проходов и предупреждение доработки',
  tags: ['ci'],
  parameters: { songframe: scenarioWorkflowOptions('accepted') },
  play: async (context) => {
    const screen = await ready(context);
    // Отказ от подтверждения ничего не запускает.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createTreatment }));
    let confirmation = within(await screen.findByRole('dialog', { name: scenarioTexts.workflow.confirmTitle.treatment }));
    await expect(confirmation.getByRole('alert')).toHaveTextContent(`${scenarioTexts.accepted.treatment({ shots: ['M01'] })} ${scenarioTexts.accepted.kept}`);
    await userEvent.click(confirmation.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 0.');
    // Доработка принятого плана предупреждает в своём окне, без второго подтверждения.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.revise.title }));
    const revise = within(await screen.findByRole('dialog'));
    await expect(revise.getByText(new RegExp(scenarioTexts.accepted.revise({ shots: ['M01'] }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
    await userEvent.click(revise.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Согласие запускает сценарий.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    confirmation = within(await screen.findByRole('dialog', { name: scenarioTexts.workflow.confirmTitle.scenes }));
    await expect(confirmation.getByRole('alert')).toHaveTextContent(scenarioTexts.accepted.scenes({ shots: ['M01'] }));
    await userEvent.click(confirmation.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
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
export const ReviseNoteReset: Story = {
  name: 'Доработка M01 · отмена хранит черновик, запуск очищает замечание',
  tags: ['ci'],
  parameters: { songframe: scenarioWorkflowOptions('revise') },
  play: async (context) => {
    const screen = await ready(context);
    const open = async () => {
      await userEvent.click(screen.getByRole('button', { name: scenarioTexts.revise.title }));
      return within(await screen.findByRole('dialog'));
    };
    // Отмена окна оставляет набранный текст черновиком до следующего открытия.
    let dialog = await open();
    await userEvent.type(dialog.getByRole('textbox', { name: scenarioTexts.revise.note }), 'Показать мокрую куртку.');
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = await open();
    await expect(dialog.getByRole('textbox', { name: scenarioTexts.revise.note })).toHaveValue('Показать мокрую куртку.');
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.revise.prepare }));
    await waitFor(() => expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.'));
    await expect(screen.getByTestId('scenario-note')).toHaveTextContent('Отправленное замечание для M01: Показать мокрую куртку.');
    // После готового предложения окно открывается пустым: случайное нажатие не повторит прежнюю доработку.
    await userEvent.click(await screen.findByRole('button', { name: 'Завершить демонстрационное задание' }));
    await screen.findByRole('button', { name: scenarioTexts.workflow.reviewProposal }, { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('button', { name: scenarioTexts.revise.title })).toBeEnabled());
    dialog = await open();
    await expect(dialog.getByRole('textbox', { name: scenarioTexts.revise.note })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: scenarioTexts.revise.prepare })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await expect(screen.getByTestId('scenario-counts')).toHaveTextContent('Запусков: 1.');
  }
};
