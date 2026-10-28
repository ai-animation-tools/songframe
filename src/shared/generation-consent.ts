/** Согласие на неизвестную цену разрешает только неизвестную стоимость, но не подтверждённую нехватку средств. */
import { countLabel } from './plural';
export interface GenerationPrice {
  credits: number | null;
  balance: number | null;
  verdict: 'ok' | 'insufficient_balance' | 'cost_or_balance_unknown';
}

export function canAgreeToUnknownCost(quote: GenerationPrice | null | undefined): boolean {
  return quote?.verdict === 'cost_or_balance_unknown' && quote.credits === null;
}

export function priceAllowsGeneration(quote: GenerationPrice | null | undefined, agreedToUnknownCost = false): boolean {
  return quote?.verdict === 'ok' || (agreedToUnknownCost && canAgreeToUnknownCost(quote));
}

export function formatCredits(value: number | null | undefined): string {
  return typeof value === 'number' ? countLabel(value, 'кредит', 'кредита', 'кредитов') : 'неизвестно';
}

export interface PriceNotice {
  severity: 'info' | 'warning' | 'error';
  text: string;
}

/**
 * Итог проверки цены для показа. Неизвестная цена у провайдера, который узнаёт её по факту списания, — обычное состояние
 * новой конфигурации запроса, а не проблема: показываем её спокойно и объясняем, когда цена появится.
 */
export function priceNotice(
  quote: GenerationPrice | null | undefined,
  provider: { title: string; learnsPriceFromCharges: boolean } | null
): PriceNotice | null {
  if (!quote) return null;
  const balance = `Остаток: ${formatCredits(quote.balance)}.`;
  if (quote.verdict === 'ok') return { severity: 'info', text: `Стоимость: ${formatCredits(quote.credits)}. ${balance}` };
  if (quote.verdict === 'insufficient_balance')
    return { severity: 'error', text: `Стоимость: ${formatCredits(quote.credits)}. ${balance} Кредитов недостаточно.` };
  if (!canAgreeToUnknownCost(quote) || quote.balance === null)
    return { severity: 'warning', text: `Стоимость: ${formatCredits(quote.credits)}. ${balance} Остаток кредитов не подтверждён, отправка недоступна.` };
  if (provider?.learnsPriceFromCharges)
    return {
      severity: 'info',
      text: `Стоимость: станет известна после первого такого запроса. ${balance} ${provider.title} не сообщает цену заранее; приложение запомнит фактическое списание и покажет цену для таких же запросов. Чтобы разрешить этот запрос, нажмите «Я согласен».`
    };
  return { severity: 'warning', text: `Стоимость: неизвестно. ${balance} Чтобы разрешить один запрос с неизвестным списанием, нажмите «Я согласен».` };
}
