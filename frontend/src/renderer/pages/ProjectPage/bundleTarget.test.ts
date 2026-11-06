import { describe, expect, it } from 'vitest';
import { bundleName, renewedBundleTarget } from './bundleTarget';

describe('имя папки пакета для монтажёра', () => {
  const date = new Date(2026, 10, 6, 13, 29, 7);

  it('содержит секунды', () => {
    expect(bundleName(date)).toBe('edit-bundle-20261106-132907');
  });

  it('заменяет автоматическое имя и сохраняет выбранную папку', () => {
    expect(renewedBundleTarget('/клип/plan/batches/edit-bundle-20261106-1329', date)).toBe('/клип/plan/batches/edit-bundle-20261106-132907');
    expect(renewedBundleTarget('C:\\клип\\edit-bundle-20261106-130000', date)).toBe('C:\\клип\\edit-bundle-20261106-132907');
  });

  it('не трогает имя пользователя', () => {
    expect(renewedBundleTarget('/клип/plan/batches/для-монтажёра', date)).toBe('/клип/plan/batches/для-монтажёра');
  });
});
