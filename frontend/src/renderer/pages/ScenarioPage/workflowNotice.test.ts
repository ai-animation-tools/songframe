import { describe, expect, it } from 'vitest';
import { proposalNotice } from './workflowNotice';

describe('proposalNotice', () => {
  it('сообщает о готовности и ошибке только после выполнявшегося задания', () => {
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'a', status: 'ready' })?.severity).toBe('success');
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'a', status: 'failed', message: 'Сбой' })).toEqual({ message: 'Сбой', severity: 'error' });
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'a', status: 'interrupted' })?.severity).toBe('warning');
    // Остановку пользователь выбрал сам: подтверждение без ошибки.
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'a', status: 'cancelled', message: 'Подготовка остановлена' })?.severity).toBe('info');
  });

  it('молчит при открытии страницы, смене предложения и продолжении работы', () => {
    expect(proposalNotice(null, { id: 'a', status: 'ready' })).toBeNull();
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'b', status: 'ready' })).toBeNull();
    expect(proposalNotice({ id: 'a', status: 'running' }, { id: 'a', status: 'running' })).toBeNull();
    expect(proposalNotice({ id: 'a', status: 'ready' }, { id: 'a', status: 'applied' })).toBeNull();
  });
});
