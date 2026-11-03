/** Согласие на неизвестную цену разрешает только неизвестную стоимость, но не подтверждённую нехватку средств. */
import { generationTexts } from './texts/generation';
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
  return generationTexts.credits(value);
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
  const values = { cost: quote.credits, balance: quote.balance };
  if (quote.verdict === 'ok') return { severity: 'info', text: generationTexts.priceConfirmed(values) };
  if (quote.verdict === 'insufficient_balance') return { severity: 'error', text: generationTexts.insufficientBalance(values) };
  if (!canAgreeToUnknownCost(quote) || quote.balance === null) return { severity: 'warning', text: generationTexts.balanceUnconfirmed(values) };
  if (provider?.learnsPriceFromCharges)
    return {
      severity: 'info',
      text: generationTexts.priceAfterCharges({ balance: quote.balance, provider: provider.title })
    };
  return { severity: 'warning', text: generationTexts.unknownPrice({ balance: quote.balance }) };
}
