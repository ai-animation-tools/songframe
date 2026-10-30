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

/** Целые сообщения проверяются независимо от словаря, включая сохранённое согласование чисел. */
describe('дословные сообщения согласования цены', () => {
  it.each([
    [0, '0 кредитов'],
    [1, '1 кредит'],
    [2, '2 кредита'],
    [5, '5 кредитов'],
    [11, '11 кредитов'],
    [21, '21 кредит'],
    [-21, '-21 кредит'],
    [2.5, '2.5 кредита']
  ] as const)('сохраняет форму числа %s в полной подтверждённой цене', (credits, expected) => {
    expect(priceNotice({ credits, balance: 21, verdict: 'ok' }, null)).toEqual({
      severity: 'info',
      text: `Стоимость: ${expected}. Остаток: 21 кредит.`
    });
  });

  it('сохраняет полные причины запрета при нехватке средств и неподтверждённом остатке', () => {
    expect(priceNotice({ credits: 5, balance: 2, verdict: 'insufficient_balance' }, null)).toEqual({
      severity: 'error',
      text: 'Стоимость: 5 кредитов. Остаток: 2 кредита. Кредитов недостаточно.'
    });
    expect(priceNotice({ credits: 5, balance: null, verdict: 'cost_or_balance_unknown' }, null)).toEqual({
      severity: 'warning',
      text: 'Стоимость: 5 кредитов. Остаток: неизвестно. Остаток кредитов не подтверждён, отправка недоступна.'
    });
    expect(priceNotice({ credits: null, balance: null, verdict: 'cost_or_balance_unknown' }, null)).toEqual({
      severity: 'warning',
      text: 'Стоимость: неизвестно. Остаток: неизвестно. Остаток кредитов не подтверждён, отправка недоступна.'
    });
  });

  it('сохраняет обе полные фразы согласия и передаёт название провайдера без интерпретации', () => {
    const quote: GenerationPrice = { credits: null, balance: 0, verdict: 'cost_or_balance_unknown' };
    expect(priceNotice(quote, null)).toEqual({
      severity: 'warning',
      text: 'Стоимость: неизвестно. Остаток: 0 кредитов. Чтобы разрешить один запрос с неизвестным списанием, нажмите «Я согласен».'
    });
    expect(priceNotice(quote, { title: '«Сервис» <test> & C:\\media\\{name}', learnsPriceFromCharges: true })).toEqual({
      severity: 'info',
      text: 'Стоимость: станет известна после первого такого запроса. Остаток: 0 кредитов. «Сервис» <test> & C:\\media\\{name} не сообщает цену заранее; приложение запомнит фактическое списание и покажет цену для таких же запросов. Чтобы разрешить этот запрос, нажмите «Я согласен».'
    });
    expect(priceNotice(null, null)).toBeNull();
  });
});
