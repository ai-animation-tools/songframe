/** Параметр плана выбирает только существующий план; уход со страницы не теряет черновики молча. */
import { describe, expect, it } from 'vitest';
import type { ScenesFile } from '@shared/types';
import { scenarioTexts } from '@shared/texts/scenario';
import { requestedShot, unsavedDraftsReason } from './shotNavigation';

const scenes = { scenes: [{ id: 'M01' }, { id: 'M02' }] } as unknown as ScenesFile;

describe('requestedShot', () => {
  it('выбирает план из параметра, если он есть в реестре', () => {
    expect(requestedShot(scenes, 'M02')).toBe('M02');
  });

  it('без параметра, реестра или такого плана оставляет обычный выбор', () => {
    expect(requestedShot(scenes, null)).toBeNull();
    expect(requestedShot(null, 'M02')).toBeNull();
    expect(requestedShot(scenes, 'M99')).toBeNull();
  });
});

describe('unsavedDraftsReason', () => {
  it('без правок переход доступен', () => {
    expect(unsavedDraftsReason(false)).toBeNull();
  });

  it('предупреждает о несохранённом сценарии', () => {
    expect(unsavedDraftsReason(true)).toBe(scenarioTexts.leave.scenesDirty);
  });
});
