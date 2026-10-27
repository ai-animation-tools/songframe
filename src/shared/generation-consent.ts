/** Согласие на неизвестную цену разрешает только неизвестную стоимость, но не подтверждённую нехватку средств. */
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
  return typeof value === 'number' ? `${value} кредитов` : 'неизвестно';
}
