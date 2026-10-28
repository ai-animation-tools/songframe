/** Неизвестная цена требует отдельного согласия; известная нехватка средств этим согласием не отменяется. */
import { describe, expect, it } from 'vitest';
import { canAgreeToUnknownCost, formatCredits, priceAllowsGeneration, type GenerationPrice, priceNotice } from './generation-consent';

describe('согласие на неизвестную стоимость', () => {
  it('показывает неизвестное значение без единиц, сохраняя нулевую цену', () => {
    expect(formatCredits(null)).toBe('неизвестно');
    expect(formatCredits(undefined)).toBe('неизвестно');
    expect(formatCredits(0)).toBe('0 кредитов');
    expect(formatCredits(2.5)).toBe('2.5 кредита');
    expect(formatCredits(24)).toBe('24 кредита');
  });

  it.each([null, 100])('разрешает неизвестную цену только с согласием при остатке %s', (balance) => {
    const quote: GenerationPrice = { credits: null, balance, verdict: 'cost_or_balance_unknown' };
    expect(canAgreeToUnknownCost(quote)).toBe(true);
    expect(priceAllowsGeneration(quote)).toBe(false);
    expect(priceAllowsGeneration(quote, true)).toBe(true);
  });

  it('сохраняет запрет при известной нехватке средств и известной цене без остатка', () => {
    for (const quote of [
      { credits: 5, balance: 2, verdict: 'insufficient_balance' },
      { credits: 5, balance: null, verdict: 'cost_or_balance_unknown' }
    ] satisfies GenerationPrice[]) {
      expect(canAgreeToUnknownCost(quote)).toBe(false);
      expect(priceAllowsGeneration(quote, true)).toBe(false);
    }
  });

  it('обычная подтверждённая оценка не требует согласия на неизвестную цену', () => {
    expect(priceAllowsGeneration({ credits: 0, balance: 0, verdict: 'ok' })).toBe(true);
    expect(priceAllowsGeneration(null, true)).toBe(false);
    expect(priceAllowsGeneration(undefined, true)).toBe(false);
  });
});

describe('сообщение о цене', () => {
  const learns = { title: 'Сервис', learnsPriceFromCharges: true };
  it('неизвестная цена у провайдера, узнающего её по списанию, — спокойная подсказка', () => {
    const notice = priceNotice({ credits: null, balance: 1167, verdict: 'cost_or_balance_unknown' }, learns);
    expect(notice?.severity).toBe('info');
    expect(notice?.text).toContain('станет известна после первого такого запроса');
    expect(notice?.text).toContain('Сервис не сообщает цену заранее');
  });
  it('без такого свойства и при неизвестном остатке остаётся предупреждение', () => {
    expect(priceNotice({ credits: null, balance: 10, verdict: 'cost_or_balance_unknown' }, { title: 'Сервис', learnsPriceFromCharges: false })?.severity).toBe(
      'warning'
    );
    expect(priceNotice({ credits: null, balance: null, verdict: 'cost_or_balance_unknown' }, learns)?.severity).toBe('warning');
    expect(priceNotice({ credits: 30, balance: 10, verdict: 'insufficient_balance' }, learns)?.severity).toBe('error');
    expect(priceNotice({ credits: 24, balance: 1167, verdict: 'ok' }, learns)?.text).toBe('Стоимость: 24 кредита. Остаток: 1167 кредитов.');
  });
});
