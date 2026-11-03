/** Согласование опоры меняет пакет; ошибка не снимает вопрос и не теряет введённое замечание. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { KeyframeReviewStory, keyframePackage } from '../../../testing/keyframeStories';
import { PYTHON_REASON } from '../constants';

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

export const Pending: Story = { name: 'Текущая опора · замечание обязательно только для доработки' };
export const NoQuestion: Story = { name: 'Нет открытого вопроса', args: { initialPackage: keyframePackage({ pendingDecision: null }) } };
export const Whitespace: Story = {
  name: 'Пробельное замечание · доработка запрещена',
  args: { initialNote: '   \n   ' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Доработать K02' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Утвердить K02' })).toBeEnabled();
  }
};
export const ApproveSequence: Story = {
  name: 'Принятие по одной · K02 затем K03',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Утвердить K02' }));
    await canvas.findByRole('button', { name: 'Утвердить K03' });
    await expect(canvas.getByText(/Опоры · утверждено 2 из 4/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Утвердить K03' }));
    await canvas.findByText('Утверждена только K03.');
    await expect(canvas.getByText(/Опоры · утверждено 3 из 4/)).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /Утвердить K/ })).not.toBeInTheDocument();
  }
};
export const ReviseFollowing: Story = {
  name: 'Доработка · замечание для этой и следующих опор',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' }), '  Камера ниже.  ');
    await userEvent.click(canvas.getByRole('button', { name: 'Доработать K02' }));
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
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Учесть и для следующих опор' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' }), 'Ворота целиком в кадре.');
    await userEvent.click(canvas.getByRole('button', { name: 'Доработать K02' }));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getByText(/^только K02(?: ·|$)/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Подставить готового кандидата' }));
    await expect(await canvas.findByRole('checkbox', { name: 'Учесть и для следующих опор' })).toBeChecked();
    await expect(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' })).toHaveValue('');
  }
};
export const ScopeReset: Story = {
  name: 'Новый вопрос · охват сбрасывается на следующие опоры',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Учесть и для следующих опор' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Утвердить K02' }));
    await canvas.findByRole('button', { name: 'Утвердить K03' });
    await expect(canvas.getByRole('checkbox', { name: 'Учесть и для следующих опор' })).toBeChecked();
  }
};
export const ModelReset: Story = {
  name: 'Сброс модели · исходный вопрос, черновик и охват',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Учесть и для следующих опор' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' }), 'Черновик до сброса.');
    await userEvent.click(canvas.getByRole('button', { name: 'Снять замечание к K02' }));
    await canvas.findByText('Замечание снято и больше не учитывается.');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('checkbox', { name: 'Учесть и для следующих опор' })).toBeChecked();
    await expect(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' })).toHaveValue('');
    await expect(canvas.getByRole('button', { name: 'Снять замечание к K02' })).toBeEnabled();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' }), 'Замечание после сброса.');
    await userEvent.click(canvas.getByRole('button', { name: 'Доработать K02' }));
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
    await userEvent.click(canvas.getByRole('button', { name: 'Доработать K02' }));
    await canvas.findByText('Не удалось сохранить решение. Кандидаты и замечание сохранены: повторите действие.');
    await expect(canvas.getByRole('textbox', { name: 'Что исправить в опоре K02' })).toHaveValue('Сохранить исходное освещение.');
    await expect(canvas.getByRole('button', { name: /Открыть крупно: K02/ })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Доработать K02' }));
    await canvas.findByText('Кандидат K02 снят; замечание сохранено. Новая генерация не запускалась.');
    await expect(canvas.getByText('Сохранить исходное освещение.')).toBeInTheDocument();
  }
};
export const Busy: Story = { name: 'Запись решения · ответы заблокированы', args: { busy: true, initialNote: 'Черновик сохраняется во время операции.' } };
export const RuntimeUnavailable: Story = { name: 'Нет Python · ответы заблокированы с причиной', args: { busy: true, busyReason: PYTHON_REASON } };
