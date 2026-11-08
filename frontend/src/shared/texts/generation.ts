/** Подтверждение стоимости и параметры генерации; числовые формы принадлежат plural.ts. */
import { countLabel } from '../plural';

type Credits = number | null | undefined;

function credits(value: Credits): string {
  return typeof value === 'number' ? countLabel(value, 'кредит', 'кредита', 'кредитов') : 'неизвестно';
}

export const generationTexts = {
  credits,
  priceConfirmed: ({ cost, balance }: { cost: Credits; balance: Credits }) => `Стоимость: ${credits(cost)}. Остаток: ${credits(balance)}.`,
  insufficientBalance: ({ cost, balance }: { cost: Credits; balance: Credits }) =>
    `Стоимость: ${credits(cost)}. Остаток: ${credits(balance)}. Кредитов недостаточно.`,
  balanceUnconfirmed: ({ cost, balance }: { cost: Credits; balance: Credits }) =>
    `Стоимость: ${credits(cost)}. Остаток: ${credits(balance)}. Остаток кредитов не подтверждён, отправка недоступна.`,
  priceAfterCharges: ({ balance, provider }: { balance: Credits; provider: string }) =>
    `Стоимость: станет известна после первого такого запроса. Остаток: ${credits(balance)}. ${provider} не сообщает цену заранее; приложение запомнит фактическое списание и покажет цену для таких же запросов. Чтобы разрешить этот запрос, нажмите «Я согласен».`,
  unknownPrice: ({ balance }: { balance: Credits }) =>
    `Стоимость: неизвестно. Остаток: ${credits(balance)}. Чтобы разрешить один запрос с неизвестным списанием, нажмите «Я согласен».`,
  durationRules: {
    min_supported_strictly_greater_than_window: 'Ближайшая поддерживаемая длительность строго больше окна',
    min_supported_not_less_than_window: 'Ближайшая поддерживаемая длительность не меньше окна',
    exact_window: 'Ровно окно сцены'
  }
} as const;
