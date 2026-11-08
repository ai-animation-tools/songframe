/** Согласование опоры меняет пакет; ошибка не снимает вопрос и не теряет введённое замечание. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { KeyframeReviewStory, keyframePackage } from '../../../testing/keyframeStories';

const texts = productionTexts.packageDecision;
const SCOPE = productionTexts.keyframeNoteScopeField.following;
const noteField = { name: texts.frameNote({ frame: 'K02' }) };
const reviseButton = { name: texts.revise({ frame: 'K02' }) };
const approveButton = { name: texts.approve({ frame: 'K02' }) };
type Canvas = ReturnType<typeof within>;
/** Поле замечания и охват открываются кнопкой доработки: до неё решение не про замечание. */
const openRevision = (canvas: Canvas): Promise<void> => userEvent.click(canvas.getByRole('button', reviseButton));

const meta = {
  title: 'Производство/Опоры/Решения',
  component: KeyframeReviewStory,
  // Последовательные клики по вопросам требуют собственного Canvas и фокуса.
  tags: ['!autodocs'],
  args: { showFrames: true, showDecision: true },
  parameters: { controls: { disable: true } },
  render: (args) => <KeyframeReviewStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof KeyframeReviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  name: 'Текущая опора · замечание обязательно только для доработки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('textbox', noteField)).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox', { name: SCOPE })).not.toBeInTheDocument();
    await openRevision(canvas);
    await expect(canvas.getByRole('textbox', noteField)).toHaveFocus();
    await expect(canvas.getByRole('checkbox', { name: SCOPE })).toBeChecked();
    await expect(canvas.getByRole('button', reviseButton)).toBeDisabled();
    await expect(canvas.getByRole('button', approveButton)).toBeEnabled();
  }
};
export const NoQuestion: Story = { name: 'Нет открытого вопроса', args: { initialPackage: keyframePackage({ pendingDecision: null }) } };
export const Whitespace: Story = {
  name: 'Пробельное замечание · доработка запрещена',
  args: { initialNote: '   \n   ' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Пробелы не считаются замечанием: поле закрыто, пока его не откроет сама доработка.
    await openRevision(canvas);
    await expect(canvas.getByRole('button', reviseButton)).toBeDisabled();
    await expect(canvas.getByRole('button', approveButton)).toBeEnabled();
  }
};
export const ApproveSequence: Story = {
  name: 'Принятие по одной · K02 затем K03',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', approveButton));
    await canvas.findByRole('button', { name: texts.approve({ frame: 'K03' }) });
    await expect(canvas.getByText(/Опоры · утверждено 2 из 4/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: texts.approve({ frame: 'K03' }) }));
    await canvas.findByText('Утверждена только K03.');
    await expect(canvas.getByText(/Опоры · утверждено 3 из 4/)).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /Утвердить K/ })).not.toBeInTheDocument();
  }
};
export const ReviseFollowing: Story = {
  name: 'Доработка · замечание для этой и следующих опор',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openRevision(canvas);
    await userEvent.type(canvas.getByRole('textbox', noteField), '  Камера ниже.  ');
    await userEvent.click(canvas.getByRole('button', reviseButton));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getByText('Камера ниже.')).toBeInTheDocument();
    // Дата замечания добавляется к той же подписи; проверяем охват независимо от её форматирования.
    await expect(canvas.getAllByText(/^K02 и следующие опоры(?: ·|$)/)).toHaveLength(2);
    await expect(canvas.queryByRole('button', { name: /Открыть крупно: K02/ })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Открыть крупно: K03/ })).toBeInTheDocument();
  }
};
export const ReviseSingle: Story = {
  name: 'Доработка · только эта опора и новый отдельный вопрос',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openRevision(canvas);
    await userEvent.click(canvas.getByRole('checkbox', { name: SCOPE }));
    await userEvent.type(canvas.getByRole('textbox', noteField), 'Ворота целиком в кадре.');
    await userEvent.click(canvas.getByRole('button', reviseButton));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getByText(/^только K02(?: ·|$)/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Подставить готового кандидата' }));
    // Новый вопрос начинает с закрытого поля, пустого замечания и охвата по умолчанию.
    await canvas.findByRole('button', reviseButton);
    await expect(canvas.queryByRole('textbox', noteField)).not.toBeInTheDocument();
    await openRevision(canvas);
    await expect(await canvas.findByRole('checkbox', { name: SCOPE })).toBeChecked();
    await expect(canvas.getByRole('textbox', noteField)).toHaveValue('');
  }
};
export const ScopeReset: Story = {
  name: 'Новый вопрос · охват сбрасывается на следующие опоры',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openRevision(canvas);
    await userEvent.click(canvas.getByRole('checkbox', { name: SCOPE }));
    await userEvent.click(canvas.getByRole('button', approveButton));
    await canvas.findByRole('button', { name: texts.approve({ frame: 'K03' }) });
    await expect(canvas.queryByRole('checkbox', { name: SCOPE })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: texts.revise({ frame: 'K03' }) }));
    await expect(canvas.getByRole('checkbox', { name: SCOPE })).toBeChecked();
  }
};
export const ModelReset: Story = {
  name: 'Сброс модели · исходный вопрос, черновик и охват',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openRevision(canvas);
    await userEvent.click(canvas.getByRole('checkbox', { name: SCOPE }));
    await userEvent.type(canvas.getByRole('textbox', noteField), 'Черновик до сброса.');
    await userEvent.click(canvas.getByRole('button', { name: 'Снять замечание к K02' }));
    await canvas.findByText('Замечание снято и больше не учитывается.');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByRole('textbox', noteField)).not.toBeInTheDocument();
    await openRevision(canvas);
    await expect(canvas.getByRole('checkbox', { name: SCOPE })).toBeChecked();
    await expect(canvas.getByRole('textbox', noteField)).toHaveValue('');
    await expect(canvas.getByRole('button', { name: 'Снять замечание к K02' })).toBeEnabled();
    await userEvent.type(canvas.getByRole('textbox', noteField), 'Замечание после сброса.');
    await userEvent.click(canvas.getByRole('button', reviseButton));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getAllByText(/^K02 и следующие опоры(?: ·|$)/)).toHaveLength(2);
    await expect(canvas.queryByText(/^только K02(?: ·|$)/)).not.toBeInTheDocument();
  }
};
export const FailureRetry: Story = {
  name: 'Ошибка записи · повтор с тем же вопросом и замечанием',
  args: { failFirst: true, initialNote: 'Сохранить исходное освещение.' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', reviseButton));
    await canvas.findByText('Не удалось сохранить решение. Кандидаты и замечание сохранены: повторите действие.');
    await expect(canvas.getByRole('textbox', noteField)).toHaveValue('Сохранить исходное освещение.');
    await expect(canvas.getByRole('button', { name: /Открыть крупно: K02/ })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', reviseButton));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getByText('Сохранить исходное освещение.')).toBeInTheDocument();
  }
};
export const Busy: Story = { name: 'Запись решения · ответы заблокированы', args: { busy: true, initialNote: 'Черновик сохраняется во время операции.' } };
