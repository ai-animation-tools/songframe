/** Шапка плана: выбор попытки, редкие действия в меню и принятое видео производного плана. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ProductionShotStory, productionShot, preparedPackage, queuedPackage, RETRY_ERROR } from '../../../testing/productionQueueStories';
import { STORY_VIDEO_PATH } from '../../../testing/storybook';
import { BUSY_REASON } from '../constants';
import { attemptLabel } from '../planPath';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';

const texts = productionTexts.productionShotCard;
const path = productionTexts.planPath;
const confirmRetry = productionTexts.regenerateDialog.confirm;
const KEEPS_ASSET = 'Принятый комплект: сохранён.';

/** Открывает меню карточки: выключенный пункт остаётся в списке, поэтому пункты ищутся уже в открытом меню. */
async function openMenu(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: path.moreActions }));
  return within(await within(canvasElement.ownerDocument.body).findByRole('menu'));
}
/** Выключенный пункт повтора: причина лежит в title, щелчок ничего не делает. */
async function expectRetryBlocked(canvasElement: HTMLElement, reason: string) {
  const item = (await openMenu(canvasElement)).getByRole('menuitem', { name: (name) => name.startsWith(path.retryFromRequest) });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveTextContent(reason);
  return item;
}

const meta = {
  title: 'Производство/Планы/Карточка плана',
  component: ProductionShotStory,
  // Подтверждение повтора управляет фокусом и выполняется только в отдельном Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ProductionShotStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ProductionShotStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const derived = { derivedFrom: 'M01', state: 'completed' } as const;
export const Accepted: Story = {
  name: 'Производный план · принятое видео показывается в самой карточке',
  args: { initialShot: productionShot(derived) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(texts.accepted)).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(2);
    // У производного плана нет попыток: выбора и меню тоже нет.
    await expect(canvas.queryByRole('combobox')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: path.moreActions })).not.toBeInTheDocument();
  }
};
export const RegularAccepted: Story = {
  name: 'Обычный план · принятое видео в шаге «Результат», а не в карточке',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(texts.accepted)).not.toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(0);
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent(KEEPS_ASSET);
  }
};
export const Stale: Story = {
  name: 'Постановка изменена · принятое видео сохранено, повтора нет',
  args: { initialShot: productionShot({ state: 'stale', stageLabel: 'Постановка изменена' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Постановка плана изменилась после приёмки/)).toBeInTheDocument();
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent(KEEPS_ASSET);
    const menu = await openMenu(canvasElement);
    await expect(menu.getByRole('menuitem', { name: path.newAttempt })).toBeInTheDocument();
    await expect(menu.queryByRole('menuitem', { name: path.retryFromRequest })).not.toBeInTheDocument();
  }
};
export const MissingVideo: Story = {
  name: 'Приёмка сохранена · монтажный файл отсутствует',
  args: { initialShot: productionShot({ ...derived, asset: { dir: '/mock/assets/shots/M02', video: null, original: STORY_VIDEO_PATH } }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(texts.missingVideo)).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(1);
  }
};
export const NoMaterial: Story = {
  name: 'План ещё не производился · материала и меню нет',
  args: {
    initialShot: productionShot({ state: 'planned', stageLabel: 'Запланирован', asset: null, regenerateProblem: 'Нет сохранённого запроса для повтора.' })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(texts.accepted)).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: path.moreActions })).not.toBeInTheDocument();
  }
};
const waiting = preparedPackage();
export const OpenWaiting: Story = {
  name: 'Открыть попытку · выбранный вопрос больше не дублируется',
  args: { initialShot: productionShot({ packages: [waiting], attention: waiting.pendingDecision!.question }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: texts.openPackage }));
    await expect(canvas.getByText(/Открыт пакет: plan\/batches\/M02-attempt-01/)).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: texts.openPackage })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('button', { name: texts.openPackage })).toBeInTheDocument();
  }
};
export const LongLabels: Story = {
  name: 'Длинные название, постановка и вопрос пакета',
  args: {
    initialShot: productionShot({
      title: 'Возвращение героя к старым воротам после долгого пути через посёлок при вечернем свете из окна',
      original:
        'Герой останавливается у закрытых ворот, ставит сумку на землю, замечает свет в окне и медленно переводит взгляд на калитку. Сохранить одежду, повреждение рукава и направление освещения из предыдущего плана.',
      packages: [
        {
          ...waiting,
          pendingDecision: {
            ...waiting.pendingDecision!,
            question: 'Подтвердить подготовленный запрос с сохранением положения персонажа, вечернего света и всех утверждённых опор?'
          }
        }
      ]
    })
  }
};
const second = preparedPackage('02');
export const AttemptChoice: Story = {
  name: 'Выбор попытки · подпись с номером и этапом, повторный выбор',
  args: { initialShot: productionShot({ packages: [waiting, { ...second, pendingDecision: null }] }), initialSelected: waiting.dir },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const select = canvas.getByRole('combobox', { name: new RegExp(productionTexts.productionPage.packageLabel) });
    await expect(select).toHaveTextContent(`${attemptLabel(waiting)} · ${waiting.stageLabel}`);
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole('option', { name: `${attemptLabel(second)} · ${second.stageLabel}` }));
    await expect(select).toHaveTextContent(attemptLabel(second));
    await expect(canvas.getByText(/Открыт пакет: plan\/batches\/M02-attempt-02/)).toBeInTheDocument();
    // Вопрос попытки, с которой ушли, остаётся виден и возвращает к ней.
    await userEvent.click(await canvas.findByRole('button', { name: texts.openPackage }));
    await expect(select).toHaveTextContent(attemptLabel(waiting));
  }
};
export const NewAttempt: Story = {
  name: 'Меню · новая попытка с описания открывает подготовку',
  args: { initialShot: productionShot({ packages: [waiting] }), initialSelected: waiting.dir },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await openMenu(canvasElement)).getByRole('menuitem', { name: path.newAttempt }));
    await expect(canvas.getByRole('combobox', { name: new RegExp(productionTexts.productionPage.packageLabel) })).toHaveTextContent(
      productionTexts.productionPage.newPreparation
    );
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent('Попыток: 1.');
  }
};
export const DeleteAttempt: Story = {
  name: 'Меню · удаление попытки только после подтверждения',
  args: { initialShot: productionShot({ packages: [waiting] }), initialSelected: waiting.dir },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const remove = async () => {
      await userEvent.click((await openMenu(canvasElement)).getByRole('menuitem', { name: (name) => name.startsWith(path.deleteAttempt) }));
      return screen.findByRole('dialog', { name: productionTexts.packageCard.discard });
    };
    await userEvent.click(within(await remove()).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent('Попыток: 1.');
    await userEvent.click(within(await remove()).getByRole('button', { name: productionTexts.packageCard.delete }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent('Попыток: 0.');
  }
};
const unknown = queuedPackage();
const unknownAttempt = {
  ...unknown,
  stage: 'submitted',
  waitReason: null,
  decision: { stage: 'request_choice', verdict: 'send' },
  request: { ...unknown.request!, attemptStatus: 'submission_unknown' }
};
export const UnknownSubmission: Story = {
  name: 'Исход прежней отправки неизвестен · повтор запрещён, попытку не удалить',
  args: { initialShot: productionShot({ packages: [unknownAttempt] }), initialSelected: unknownAttempt.dir },
  play: async ({ canvasElement }) => {
    await expectRetryBlocked(canvasElement, texts.submissionUnknown);
    await expect(
      within(canvasElement.ownerDocument.body).queryByRole('menuitem', { name: (name) => name.startsWith(path.deleteAttempt) })
    ).not.toBeInTheDocument();
  }
};
export const Busy: Story = {
  name: 'Операция выполняется · повтор заблокирован',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    await expectRetryBlocked(canvasElement, BUSY_REASON);
  }
};
export const IncompatibleRequest: Story = {
  name: 'Сохранённый запрос несовместим · причина важнее занятости',
  args: { busy: true, initialShot: productionShot({ regenerateProblem: 'В сохранённом комплекте отсутствует снимок запроса. Подготовьте новый пакет.' }) },
  play: async ({ canvasElement }) => {
    const item = await expectRetryBlocked(canvasElement, 'В сохранённом комплекте отсутствует снимок запроса.');
    await expect(item).not.toHaveTextContent(BUSY_REASON);
  }
};
const chooseRetry = async (canvasElement: HTMLElement) => {
  await userEvent.click((await openMenu(canvasElement)).getByRole('menuitem', { name: (name) => name.startsWith(path.retryFromRequest) }));
  return within(canvasElement.ownerDocument.body).findByRole('dialog');
};
export const PrepareRetry: Story = {
  name: 'Повтор · отмена, подтверждение и открытие новой попытки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await chooseRetry(canvasElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await userEvent.click(within(await chooseRetry(canvasElement)).getByRole('button', { name: confirmRetry }));
    await canvas.findByText(/Подготовка повтора M02: выполнено/);
    await expect(canvas.getByText(/Открыт пакет: plan\/batches\/M02-attempt-01\. Отправок генерации: 0/)).toBeInTheDocument();
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent(`Попыток: 1. ${KEEPS_ASSET}`);
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Подготовка повтора M02: выполнено/)).not.toBeInTheDocument();
  }
};
export const RetryFailure: Story = {
  name: 'Ошибка подготовки · сохранённый комплект и повтор действия',
  args: { failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const repeat = async (): Promise<void> => {
      await userEvent.click(within(await chooseRetry(canvasElement)).getByRole('button', { name: confirmRetry }));
    };
    await repeat();
    await canvas.findByText(RETRY_ERROR);
    await expect(canvas.queryByText(/Открыт пакет:/)).not.toBeInTheDocument();
    await expect(canvas.getByTestId('shot-model')).toHaveTextContent(`Попыток: 0. ${KEEPS_ASSET}`);
    await repeat();
    await canvas.findByText(/Открыт пакет: plan\/batches\/M02-attempt-01/);
    await expect(canvas.queryByText(RETRY_ERROR)).not.toBeInTheDocument();
  }
};
