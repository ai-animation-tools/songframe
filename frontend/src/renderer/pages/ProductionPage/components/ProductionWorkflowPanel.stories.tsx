/** Сценарии проходят реальные hook, опрос и подтверждения; данные и исполнитель существуют только в памяти. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { STORY_IMAGE_PATH } from '../../../testing/storybook';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { PANEL_SAVED_NOTE, WorkflowPanelStory, workflowPanelOptions } from '../../../testing/workflowPanelStories';
import { WORKFLOW_STORY_DESCRIPTION, WORKFLOW_STORY_PROJECT, WORKFLOW_STORY_PACKAGE } from '../../../testing/productionWorkflowStories';

const labels = productionTexts.productionWorkflowPanel;
const proposalLabels = productionTexts.productionProposalPreview;
const dialogLabels = productionTexts.productionProposalDialog;
const meta = {
  title: 'Производство/Подготовка/Рабочая панель',
  component: WorkflowPanelStory,
  // Модальные окна управляют фокусом; сценарии запускаются только в Canvas.
  tags: ['!autodocs'],
  parameters: { songframe: workflowPanelOptions(), controls: { disable: true } }
} satisfies Meta<typeof WorkflowPanelStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const counts = (context: Context) => screenOf(context).getByTestId('workflow-counts');
async function ready(context: Context) {
  const screen = screenOf(context);
  await waitFor(() => expect(screen.getByRole('button', { name: labels.prepare })).toBeEnabled(), { timeout: 4000 });
  return screen;
}
async function openProposal(context: Context) {
  const screen = screenOf(context);
  await userEvent.click(await screen.findByRole('button', { name: dialogLabels.open }, { timeout: 4000 }));
  const element = await screen.findByRole('dialog', { name: /Предложение для производства/ });
  // Даём MUI закончить перевод фокуса перед Escape и вложенным подтверждением.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  return within(element);
}
async function confirm(context: Context, action: 'apply' | 'discard', cancel = false) {
  const screen = screenOf(context);
  const label = action === 'apply' ? proposalLabels.apply : proposalLabels.discard;
  const dialog = within(screen.getByRole('dialog', { name: /Предложение для производства/ }));
  await userEvent.click(dialog.getByRole('button', { name: label }));
  const confirmation = within(await screen.findByRole('dialog', { name: `${label}?` }));
  await userEvent.click(
    confirmation.getByRole('button', { name: cancel ? commonTexts.cancel : action === 'apply' ? proposalLabels.applyConfirm : proposalLabels.discardConfirm })
  );
  await waitFor(() => expect(screen.queryByRole('dialog', { name: `${label}?` })).not.toBeInTheDocument());
}
async function closed(context: Context) {
  await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
}

export const Loading: Story = {
  name: 'Чтение состояния · действия ждут ответа',
  parameters: { songframe: workflowPanelOptions('loading') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(screen.getByRole('button', { name: labels.prepare })).toBeDisabled();
    await userEvent.hover(screen.getByRole('button', { name: labels.prepare }).parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(labels.loadingReason);
    await userEvent.click(screen.getByRole('button', { name: 'Завершить отложенное чтение' }));
    await ready(context);
    await expect(counts(context)).toHaveTextContent('Запусков: 0. Применений: 0.');
  }
};
export const ReadFailure: Story = {
  name: 'Ошибка чтения · штатный опрос восстанавливает панель',
  parameters: { songframe: workflowPanelOptions('readFailure') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText('Не удалось прочитать пакет. Опрос повторит чтение.')).toBeInTheDocument();
    await ready(context);
    await waitFor(() => expect(screen.queryByText('Не удалось прочитать пакет. Опрос повторит чтение.')).not.toBeInTheDocument());
  }
};
export const RunningToReady: Story = {
  name: 'Запуск → опрос → предложение без автоматического применения',
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: labels.prepare }));
    await expect(await screen.findByRole('button', { name: commonTexts.stop })).toBeEnabled();
    await expect(screen.getByTestId('workflow-busy')).toHaveTextContent('Занятость: да.');
    await expect(await screen.findByRole('button', { name: dialogLabels.open }, { timeout: 4000 })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole('button', { name: commonTexts.stop })).not.toBeInTheDocument(), { timeout: 4000 });
    await expect(counts(context)).toHaveTextContent('Запусков: 1. Применений: 0.');
    await expect(screen.getByTestId('workflow-saved')).toHaveTextContent('Исходные материалы сохранены.');
    await expect(screen.getByTestId('workflow-busy')).toHaveTextContent('Занятость: нет. Занятость наблюдалась: да.');
  }
};
export const InspectAndApply: Story = {
  name: 'Просмотр, Escape, отмена и применение · согласование отдельно',
  parameters: { songframe: workflowPanelOptions('ready') },
  play: async (context) => {
    let dialog = await openProposal(context);
    await expect(dialog.getByText(WORKFLOW_STORY_DESCRIPTION)).toBeInTheDocument();
    screenOf(context).getByRole('dialog').focus();
    await userEvent.keyboard('{Escape}');
    await closed(context);
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
    dialog = await openProposal(context);
    await confirm(context, 'apply', true);
    await expect(dialog.getByText(WORKFLOW_STORY_DESCRIPTION)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
    await confirm(context, 'apply');
    await closed(context);
    await waitFor(() => expect(counts(context)).toHaveTextContent('Применений: 1. Отклонений: 0. Обновлений пакета: 1.'));
    await expect(screenOf(context).getByTestId('workflow-saved')).toHaveTextContent(
      `Сохранено: ${WORKFLOW_STORY_DESCRIPTION}. Согласование требуется отдельно.`
    );
    await expect(screenOf(context).getByRole('button', { name: labels.continue })).toBeDisabled();
    await userEvent.click(screenOf(context).getByRole('button', { name: 'Сбросить модель' }));
    await openProposal(context);
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
  }
};
export const Discard: Story = {
  name: 'Отклонение · отмена сохраняет, подтверждение убирает предложение',
  parameters: { songframe: workflowPanelOptions('ready') },
  play: async (context) => {
    await openProposal(context);
    await confirm(context, 'discard', true);
    await expect(counts(context)).toHaveTextContent('Отклонений: 0.');
    await confirm(context, 'discard');
    await closed(context);
    await expect(counts(context)).toHaveTextContent('Применений: 0. Отклонений: 1. Обновлений пакета: 0.');
    await expect(screenOf(context).getByTestId('workflow-saved')).toHaveTextContent('Исходные материалы сохранены.');
    await expect(screenOf(context).queryByRole('button', { name: dialogLabels.open })).not.toBeInTheDocument();
    await ready(context);
  }
};
export const ApplyFailure: Story = {
  name: 'Ошибка применения · предложение и материалы остаются для повтора',
  parameters: { songframe: workflowPanelOptions('applyFailure') },
  play: async (context) => {
    const dialog = await openProposal(context);
    await confirm(context, 'apply');
    await expect(await dialog.findByText('Не удалось записать пакет. Предложение и материалы сохранены.')).toBeInTheDocument();
    await expect(dialog.getByText(WORKFLOW_STORY_DESCRIPTION)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Применений: 1. Отклонений: 0. Обновлений пакета: 0.');
    await expect(screenOf(context).getByTestId('workflow-saved')).toHaveTextContent('Исходные материалы сохранены.');
    await confirm(context, 'apply');
    await closed(context);
    await expect(counts(context)).toHaveTextContent('Применений: 2. Отклонений: 0. Обновлений пакета: 1.');
  }
};
export const Invalid: Story = {
  name: 'Некорректный ответ · причину можно прочитать и отклонить',
  parameters: { songframe: workflowPanelOptions('invalid') },
  play: async (context) => {
    const dialog = await openProposal(context);
    await expect(dialog.getByText('В ответе нет плана опор.')).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: proposalLabels.apply })).toBeDisabled();
    await confirm(context, 'discard');
    await closed(context);
    await expect(counts(context)).toHaveTextContent('Применений: 0. Отклонений: 1.');
  }
};
export const Stale: Story = {
  name: 'Исходники изменились · применение заблокировано',
  parameters: { songframe: workflowPanelOptions('stale') },
  play: async (context) => {
    const dialog = await openProposal(context);
    const apply = dialog.getByRole('button', { name: proposalLabels.apply });
    await expect(apply).toBeDisabled();
    await userEvent.hover(apply.parentElement!);
    await expect(await screenOf(context).findByRole('tooltip')).toHaveTextContent(proposalLabels.staleReason);
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
  }
};
export const Refused: Story = {
  name: 'Штатный отказ агента · объяснение вместо материалов',
  parameters: { songframe: workflowPanelOptions('refused') },
  play: async (context) => {
    const dialog = await openProposal(context);
    await expect(dialog.getByText(proposalLabels.refused)).toBeInTheDocument();
    await expect(dialog.getByText('Положение машины противоречит утверждённой сцене: уточните постановку.')).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: proposalLabels.apply })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: dialogLabels.close }));
    await closed(context);
    await expect(counts(context)).toHaveTextContent('Применений: 0. Отклонений: 0.');
  }
};
export const FailedJob: Story = {
  name: 'Задание завершилось с ошибкой · явный повтор',
  parameters: { songframe: workflowPanelOptions('failedJob') },
  play: async (context) => {
    const screen = screenOf(context);
    await userEvent.click(await screen.findByRole('button', { name: commonTexts.retry }));
    await expect(counts(context)).toHaveTextContent('Запусков: 1.');
    await userEvent.click(await screen.findByRole('button', { name: commonTexts.stop }));
    await waitFor(() => expect(screen.queryByRole('button', { name: commonTexts.stop })).not.toBeInTheDocument());
    await expect(screen.getByTestId('workflow-busy')).toHaveTextContent('Занятость: нет.');
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
    await userEvent.click(screen.getByRole('button', { name: commonTexts.retry }));
    await expect(counts(context)).toHaveTextContent('Запусков: 2.');
    await waitFor(() => expect(screen.queryByRole('button', { name: commonTexts.stop })).not.toBeInTheDocument(), { timeout: 4000 });
    await expect(screen.getByTestId('workflow-saved')).toHaveTextContent('Исходные материалы сохранены.');
    await expect(counts(context)).toHaveTextContent('Применений: 0.');
  }
};
export const SavedRevision: Story = {
  name: 'Сохранённое замечание · смена вопроса сбрасывает черновик',
  parameters: { songframe: workflowPanelOptions('revision') },
  play: async (context) => {
    const screen = screenOf(context);
    const field = await screen.findByRole('textbox', { name: labels.savedNote });
    await expect(field).toHaveValue(PANEL_SAVED_NOTE);
    await userEvent.clear(field);
    await expect(screen.getByRole('button', { name: labels.revise })).toBeDisabled();
    await userEvent.type(field, 'Черновик для прошлого вопроса');
    await userEvent.click(screen.getByRole('button', { name: 'Показать другой вопрос' }));
    await expect(field).toHaveValue('Новое замечание для другого вопроса.');
    await userEvent.click(screen.getByRole('button', { name: 'Показать другой вопрос' }));
    const frameNote = screen.getByRole('textbox', { name: labels.note });
    await expect(frameNote).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Показать другой вопрос' }));
    const currentField = screen.getByRole('textbox', { name: labels.savedNote });
    await userEvent.clear(currentField);
    await userEvent.type(currentField, '  Уточнить свет и сохранить машину.  ');
    await userEvent.click(screen.getByRole('button', { name: labels.revise }));
    await expect(screen.getByTestId('workflow-note')).toHaveTextContent('Отправленное замечание: Уточнить свет и сохранить машину.');
    await expect(counts(context)).toHaveTextContent('Запусков: 1. Применений: 0.');
  }
};
export const Paid: Story = {
  name: 'Отправленная попытка · новая подготовка скрыта',
  parameters: { songframe: workflowPanelOptions('paid') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(new RegExp('Запрос этой попытки уже отправлен'))).toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: labels.prepare })).not.toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Запусков: 0.');
  }
};
export const Derived: Story = {
  name: 'Производный план · подготовка заблокирована',
  parameters: { songframe: workflowPanelOptions('derived') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(/План собирается из материала M01/)).toBeInTheDocument();
    await expect(screen.getByRole('button', { name: labels.prepare })).toBeDisabled();
    await expect(counts(context)).toHaveTextContent('Запусков: 0.');
  }
};
export const Blocked: Story = {
  name: 'Сценарий не согласован · ссылка и причина блокировки',
  parameters: { songframe: workflowPanelOptions('blocked') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByRole('link', { name: '«Сценарий»' })).toHaveAttribute('href', '/project/scenario');
    const button = screen.getByRole('button', { name: labels.prepare });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Согласуйте сценарий на странице «Сценарий».');
  }
};
export const Offline: Story = {
  name: 'Нет сети · агент не запускается',
  parameters: { songframe: workflowPanelOptions('offline') },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(screen.getByRole('button', { name: labels.prepare })).toBeDisabled();
    await expect(counts(context)).toHaveTextContent('Запусков: 0.');
  }
};
export const MissingAgent: Story = {
  name: 'Агент не выбран · нейтральная кнопка и причина',
  parameters: { songframe: workflowPanelOptions('missing') },
  play: async (context) => {
    const screen = screenOf(context);
    const button = screen.getByRole('button', { name: labels.prepare });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(/выберите агента/i);
    await expect(counts(context)).toHaveTextContent('Запусков: 0.');
  }
};
export const LateContext: Story = {
  name: 'Смена плана и пакета · поздний ответ не переносит предложение',
  parameters: { songframe: workflowPanelOptions('late') },
  play: async (context) => {
    const screen = screenOf(context);
    await userEvent.click(screen.getByRole('button', { name: 'Выбрать M03 и другой пакет' }));
    await expect(await screen.findByText('Выбран новый пакет M03.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Завершить отложенное чтение' }));
    await expect(await screen.findByTestId('workflow-late')).toHaveTextContent('Поздний ответ получен.');
    await expect(screen.getByText(labels.title({ shot: 'M03' }))).toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: dialogLabels.open })).not.toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Применений: 0. Отклонений: 0. Обновлений пакета: 0.');
  }
};
export const SingleFrame: Story = {
  name: 'Следующая K02 · импорт и генерация сохраняют утверждённую K01',
  parameters: { songframe: workflowPanelOptions('frames') },
  play: async (context) => {
    const screen = screenOf(context);
    const importLabels = productionTexts.productionFrameImport;
    await userEvent.click(await screen.findByText(importLabels.heading));
    await expect(screen.queryByRole('button', { name: importLabels.choose({ id: 'K01' }) })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: importLabels.choose({ id: 'K02' }) }));
    await userEvent.click(screen.getByRole('button', { name: importLabels.preview }));
    await expect(screen.getByRole('button', { name: /Создать K02/ })).toBeDisabled();
    await expect(window.api.productionWorkflow.generateFrames(WORKFLOW_STORY_PROJECT, 'M02', WORKFLOW_STORY_PACKAGE)).rejects.toThrow();
    await expect(
      window.api.productionWorkflow.importFrames(WORKFLOW_STORY_PROJECT, 'M02', WORKFLOW_STORY_PACKAGE, [{ id: 'K02', path: STORY_IMAGE_PATH }])
    ).rejects.toThrow();
    let dialog = await openProposal(context);
    await expect(dialog.getByText(proposalLabels.candidate({ id: 'K02' }))).toBeInTheDocument();
    await confirm(context, 'apply');
    await closed(context);
    await expect(screen.getByTestId('workflow-saved')).toHaveTextContent('Сохранено: Кандидат K02; K01 сохранена. Согласование требуется отдельно.');
    await expect(screen.getByTestId('workflow-frames')).toHaveTextContent('K01: утверждена; /mock/story-image.png?frame=K01');
    await expect(screen.getByTestId('workflow-frames')).toHaveTextContent('K02: кандидат; /mock/story-image.png');
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить модель' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Создать K02/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Создать K02/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: commonTexts.stop })).not.toBeInTheDocument(), { timeout: 4000 });
    dialog = await openProposal(context);
    await waitFor(() => expect(dialog.getByRole('button', { name: proposalLabels.apply })).toBeEnabled(), { timeout: 4000 });
    await expect(dialog.getByText(proposalLabels.candidate({ id: 'K02' }))).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Запусков: 1. Применений: 0.');
  }
};

export const MissingJobResult: Story = {
  name: 'Повреждённый результат задания · применение не обходит проверку',
  parameters: { songframe: workflowPanelOptions('ready') },
  play: async (context) => {
    const screen = screenOf(context);
    // Проверяем границу API для отсутствующего, чужого и незавершённого задания.
    for (let fault = 0; fault < 3; fault++) {
      await userEvent.click(screen.getByRole('button', { name: 'Повредить результат задания' }));
      await expect(window.api.productionWorkflow.apply(WORKFLOW_STORY_PROJECT, 'M02', undefined, 'proposal-description-1')).rejects.toThrow(
        'Нет успешно завершённого задания этого предложения.'
      );
      await expect(counts(context)).toHaveTextContent('Применений: 0.');
      await expect(screen.getByTestId('workflow-saved')).toHaveTextContent('Исходные материалы сохранены.');
    }
  }
};
