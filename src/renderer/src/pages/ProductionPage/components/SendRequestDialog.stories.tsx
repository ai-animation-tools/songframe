/** Истории проходят рабочее подтверждение, оценку и отправку; платная сторона заменена локальной моделью. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
import { SendRequestStory, sendRequestOptions } from '../../../testing/sendRequestStories';

const labels = productionTexts.sendRequestDialog;
const meta = {
  title: 'Производство/Отправка/Подтверждение запроса',
  component: SendRequestStory,
  // Диалог управляет фокусом и Escape; последовательности выполняются только в Canvas.
  tags: ['!autodocs'],
  parameters: { songframe: sendRequestOptions(), controls: { disable: true } },
  render: (args) => <SendRequestStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof SendRequestStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];
const screenOf = ({ canvasElement }: PlayContext) => within(canvasElement.ownerDocument.body);

async function dialogOf(context: PlayContext) {
  const dialog = await screenOf(context).findByRole('dialog', { name: labels.title });
  // После появления Paper MUI ещё переводит фокус; не посылаем Escape в незавершённый переход.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  return within(dialog);
}

async function ready(context: PlayContext) {
  const dialog = await dialogOf(context);
  await waitFor(() => expect(dialog.getByRole('button', { name: labels.refresh })).toBeEnabled());
  return dialog;
}

async function closed(context: PlayContext): Promise<void> {
  await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
}

async function counts(context: PlayContext, quotes: number, submits: number): Promise<void> {
  await waitFor(() => expect(screenOf(context).getByTestId('send-counts')).toHaveTextContent(`Проверок стоимости: ${quotes}. Попыток отправки: ${submits}.`));
}

export const KnownPrice: Story = {
  name: 'Цена известна · одна отправка запускает получение',
  play: async (context) => {
    const dialog = await ready(context);
    await expect(dialog.queryByRole('button', { name: labels.agree })).not.toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.confirm }));
    await closed(context);
    await counts(context, 1, 1);
    await expect(screenOf(context).getByText('Запрос отправлен. Задание получения: running. Результат ещё не получен.')).toBeInTheDocument();
  }
};
export const UnknownPrice: Story = {
  tags: ['ci'],
  name: 'Неизвестная цена · отдельное согласие на одну попытку',
  parameters: { songframe: sendRequestOptions({ quote: 'unknown' }) },
  play: async (context) => {
    const dialog = await ready(context);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    await expect(dialog.getByText(labels.agreed)).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.confirm }));
    await closed(context);
    await counts(context, 1, 1);
  }
};
export const InsufficientBalance: Story = {
  name: 'Недостаточно средств · согласие не обходит блокировку',
  parameters: { songframe: sendRequestOptions({ quote: 'insufficient' }) },
  play: async (context) => {
    const dialog = await ready(context);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.queryByRole('button', { name: labels.agree })).not.toBeInTheDocument();
    await expect(dialog.getByRole('alert')).toHaveTextContent(/Кредитов недостаточно/);
    await counts(context, 1, 0);
  }
};
export const QuoteLoading: Story = {
  name: 'Проверка стоимости · можно отменить ожидание',
  parameters: { songframe: sendRequestOptions({ quotePending: true }) },
  play: async (context) => {
    const dialog = await dialogOf(context);
    await expect(dialog.getByText(labels.checking({ providerTitle: 'Тестовый сервис' }))).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: labels.refresh })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(context);
    await counts(context, 1, 0);
    await userEvent.click(screenOf(context).getByRole('button', { name: 'Открыть подтверждение' }));
    await dialogOf(context);
    await counts(context, 2, 0);
  }
};
export const QuoteFailure: Story = {
  name: 'Ошибка оценки · повторная проверка восстанавливает отправку',
  parameters: { songframe: sendRequestOptions({ failQuoteOnce: true }) },
  play: async (context) => {
    const dialog = await ready(context);
    await expect(dialog.getByText('Не удалось получить оценку. Повторите проверку стоимости.')).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.refresh }));
    await waitFor(() => expect(dialog.getByRole('button', { name: labels.confirm })).toBeEnabled());
    await expect(dialog.queryByText('Не удалось получить оценку. Повторите проверку стоимости.')).not.toBeInTheDocument();
    await counts(context, 2, 0);
  }
};
export const RefreshResetsConsent: Story = {
  tags: ['ci'],
  name: 'Обновление оценки · прежнее согласие сбрасывается',
  parameters: { songframe: sendRequestOptions({ quote: 'unknown' }) },
  play: async (context) => {
    const dialog = await ready(context);
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.refresh }));
    await counts(context, 2, 0);
    await waitFor(() => expect(dialog.getByRole('button', { name: labels.agree })).toBeEnabled());
    await expect(dialog.queryByText(labels.agreed)).not.toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
  }
};
export const MissingHash: Story = {
  name: 'Нет SHA · стоимость не проверяется, отправка заблокирована',
  parameters: { songframe: sendRequestOptions({ missingSha: true }) },
  play: async (context) => {
    const dialog = await dialogOf(context);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await counts(context, 0, 0);
    await userEvent.hover(dialog.getByRole('button', { name: labels.confirm }).parentElement!);
    await expect(await screenOf(context).findByRole('tooltip')).toHaveTextContent(labels.hashMissing);
  }
};
export const MismatchedHash: Story = {
  name: 'Оценка для другого SHA · рабочий hook отклоняет ответ',
  parameters: { songframe: sendRequestOptions({ quote: 'mismatch' }) },
  play: async (context) => {
    const dialog = await ready(context);
    await expect(dialog.getByText(productionTexts.useRequestQuote.quoteMismatch)).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await counts(context, 1, 0);
  }
};
export const Offline: Story = {
  name: 'Нет сети · проверка и отправка недоступны',
  parameters: { songframe: sendRequestOptions({ offline: true }) },
  play: async (context) => {
    const dialog = await dialogOf(context);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: labels.refresh })).toBeDisabled();
    await counts(context, 0, 0);
  }
};
export const Busy: Story = {
  name: 'Другая операция выполняется · отправка заблокирована',
  args: { busy: true },
  play: async (context) => {
    const dialog = await dialogOf(context);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: labels.refresh })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: commonTexts.cancel })).toBeEnabled();
    await counts(context, 1, 0);
  }
};
export const SubmitFailure: Story = {
  tags: ['ci'],
  name: 'Ошибка отправки · новая оценка и новое согласие для повтора',
  parameters: { songframe: sendRequestOptions({ quote: 'unknown', failSubmitOnce: true }) },
  play: async (context) => {
    const dialog = await ready(context);
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    await userEvent.click(dialog.getByRole('button', { name: labels.confirm }));
    await expect(await dialog.findByText(/Не удалось отправить запрос\. Проверьте состояние пакета\./)).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.queryByRole('button', { name: labels.agree })).not.toBeInTheDocument();
    await counts(context, 1, 1);
    await userEvent.click(dialog.getByRole('button', { name: labels.refresh }));
    await waitFor(() => expect(dialog.getByRole('button', { name: labels.agree })).toBeEnabled());
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    await userEvent.click(dialog.getByRole('button', { name: labels.confirm }));
    await closed(context);
    await counts(context, 2, 2);
    await expect(screenOf(context).getByText(/Задание получения: running/)).toBeInTheDocument();
  }
};
export const SubmitPending: Story = {
  name: 'Отправка выполняется · повтор и закрытие недоступны',
  parameters: { songframe: sendRequestOptions({ submitPending: true }) },
  play: async (context) => {
    const dialog = await ready(context);
    await userEvent.dblClick(dialog.getByRole('button', { name: labels.confirm }));
    await counts(context, 1, 1);
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: labels.refresh })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: commonTexts.cancel })).toBeDisabled();
    screenOf(context).getByRole('dialog').focus();
    await userEvent.keyboard('{Escape}');
    await expect(screenOf(context).getByRole('dialog')).toBeInTheDocument();
    await counts(context, 1, 1);
  }
};
export const CancelAndReopen: Story = {
  name: 'Escape и повторное открытие · согласие не сохраняется',
  parameters: { songframe: sendRequestOptions({ quote: 'unknown' }) },
  play: async (context) => {
    let dialog = await ready(context);
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    // После согласия кнопка выключается и браузер снимает с неё фокус; проверяем Escape внутри модального окна.
    screenOf(context).getByRole('dialog').focus();
    await userEvent.keyboard('{Escape}');
    await closed(context);
    await counts(context, 1, 0);
    await userEvent.click(screenOf(context).getByRole('button', { name: 'Открыть подтверждение' }));
    dialog = await ready(context);
    await expect(dialog.getByRole('button', { name: labels.agree })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await counts(context, 2, 0);
  }
};
export const ChangedRequest: Story = {
  name: 'Новая версия запроса · промпт, SHA и согласие обновляются',
  parameters: { songframe: sendRequestOptions({ quote: 'unknown' }) },
  play: async (context) => {
    let dialog = await ready(context);
    await userEvent.click(dialog.getByRole('button', { name: labels.agree }));
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(context);
    await userEvent.click(screenOf(context).getByRole('button', { name: 'Открыть изменённый запрос' }));
    dialog = await ready(context);
    await expect(dialog.getByText('Камера отъезжает от ворот: новая версия запроса.')).toBeInTheDocument();
    await expect(dialog.getByText(labels.hash({ sha256: 'f'.repeat(64) }))).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: labels.agree })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: labels.confirm })).toBeDisabled();
    await counts(context, 2, 0);
  }
};
