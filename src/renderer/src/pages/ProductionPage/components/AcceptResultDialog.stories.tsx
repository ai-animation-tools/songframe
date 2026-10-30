/** Проверки приёмки используют рабочий диалог и отделяют запуск от завершения задания. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { AcceptResultStory } from '../../../testing/acceptResultStories';

const meta = {
  title: 'Производство/Пакет/Приёмка результата',
  component: AcceptResultStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <AcceptResultStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof AcceptResultStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const texts = productionTexts.acceptResultDialog;
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(canvas.getByRole('button', { name: 'Открыть приёмку' }));
  const element = await screen.findByRole('dialog');
  // Ждём окончания MUI-перехода, чтобы повторное открытие проверяло новый диалог.
  await waitFor(() => expect(element).toBeVisible());
  return within(element);
}
async function closed(canvasElement: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).not.toBeInTheDocument());
}
async function done(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await canvas.findByText('Задание приёмки: done.', {}, { timeout: 4000 });
  await expect(canvas.getByText('Принятый комплект: новый результат.')).toBeInTheDocument();
}

export const CutDefault: Story = {
  name: 'Новый комплект · длинный оригинал обрезается до окна',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(5);
    await expect(dialog.getByRole('spinbutton', { name: texts.holdLast })).toHaveValue(0);
    await expect(dialog.getByText(/Оригинал длиной 8,00 с/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('combobox', { name: texts.section }));
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.getByRole('option', { name: texts.full })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"expectedResultToken":"' + 'c'.repeat(64) + '"');
  }
};
export const FullDuration: Story = {
  name: 'Длительности совпали · принять оригинал целиком',
  args: { windowFrames: 240 },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('combobox', { name: texts.section })).toHaveTextContent(texts.full);
    await expect(dialog.queryByRole('spinbutton')).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
  }
};
export const HoldLast: Story = {
  name: 'Оригинал короче окна · удержать последний кадр',
  args: { windowFrames: 300 },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(8);
    await expect(dialog.getByRole('spinbutton', { name: texts.holdLast })).toHaveValue(60);
    await expect(dialog.getByText(/с удержанием последнего кадра/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"holdLast":60');
  }
};
export const ReplacementCancel: Story = {
  tags: ['ci'],
  name: 'Замена · отмена сохраняет комплект и сбрасывает согласие',
  args: { hasAsset: true },
  play: async ({ canvasElement }) => {
    let dialog = await open(canvasElement);
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const ReplacementConfirm: Story = {
  tags: ['ci'],
  name: 'Замена подтверждена · прежний комплект сохранён отдельно',
  args: { hasAsset: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Прежний комплект сохранён в assets/replaced/M02.')).toBeInTheDocument();
    await expect(canvas.getByText(/Переданные параметры:/)).toHaveTextContent('"replaceExisting":true');
  }
};
export const MissingToken: Story = {
  name: 'Результат без токена · приёмка заблокирована',
  args: { missingToken: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const confirm = dialog.getByRole('button', { name: texts.accept });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', texts.resultUnconfirmed);
    await userEvent.keyboard('{Escape}');
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const SpeechMissing: Story = {
  name: 'Речевой план без WAV · приёмка заблокирована',
  args: { speechMissing: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const confirm = dialog.getByRole('button', { name: texts.accept });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', texts.speechRequired);
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const CancelEscape: Story = {
  name: 'Escape · границы и скорость чистые при повторном открытии',
  play: async ({ canvasElement }) => {
    let dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutStart }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutStart }), '1');
    await userEvent.clear(dialog.getByRole('textbox', { name: texts.speed }));
    await userEvent.type(dialog.getByRole('textbox', { name: texts.speed }), '0.8');
    await userEvent.keyboard('{Escape}');
    await closed(canvasElement);
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('textbox', { name: texts.speed })).toHaveValue('1');
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const ResultChanged: Story = {
  name: 'Результат изменился · обновление и новое подтверждение',
  args: { changedAfterOpen: true, hasAsset: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Результат изменился. Обновите пакет и просмотрите его перед приёмкой.');
    await closed(canvasElement);
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Обновить пакет и просмотреть результат' }));
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    await expect(canvas.getByText(/Переданные параметры:/)).toHaveTextContent('"expectedResultToken":"' + 'e'.repeat(64) + '"');
  }
};
export const FailureRetry: Story = {
  name: 'Ошибка задания · старый комплект и оригинал сохраняются до повтора',
  args: { failFirst: true, hasAsset: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Задание приёмки: failed.', {}, { timeout: 4000 });
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await expect(canvas.getByText('Оригинал попытки сохранён.')).toBeInTheDocument();
    await closed(canvasElement);
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    await expect(canvas.getByText('Вызовы production.accept: 2.')).toBeInTheDocument();
  }
};
export const InvalidCut: Story = {
  name: 'Неверные границы · отказ до задания и исправленный повтор',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutEnd }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutEnd }), '0');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await canvas.findByText('Конец участка должен быть позже начала.');
    await closed(canvasElement);
    await expect(canvas.queryByText(/Задание приёмки:/)).not.toBeInTheDocument();
    await expect(canvas.queryByText('Принятый комплект: новый результат.')).not.toBeInTheDocument();
    dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutStart }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutStart }), '0.01');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await canvas.findByText('Границы участка должны быть конечными неотрицательными секундами на сетке 30 кадров/с.');
    await closed(canvasElement);
    await expect(canvas.queryByText(/Задание приёмки:/)).not.toBeInTheDocument();
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(5);
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
  }
};
export const Running: Story = {
  name: 'Задание выполняется · комплект ещё прежний, повторный запуск закрыт',
  args: { hasAsset: true, delay: 1600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.dblClick(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Задание приёмки: running.');
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await closed(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Открыть приёмку' })).toBeDisabled();
    await expect(canvas.getByText('Вызовы production.accept: 1.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByText('Задание приёмки: running.')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await expect(canvas.getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
