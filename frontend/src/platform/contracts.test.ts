/**
 * Общие JSON fixtures (testdata/contracts/api.json) проходят рабочий адаптер TS без нормализации:
 * Go проверяет тот же файл своим маршалингом. Снимки проекта прежнего временного моста (40.3)
 * больше не читаются в TS: их форму проверяет Go, а renderer получает DTO через window.api.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AppState } from '@shared/types';
import { createApi, type Bindings } from './api';

const fixtures: { appStates: { id: string; expected: AppState }[] } = JSON.parse(
  readFileSync(new URL('../../../testdata/contracts/api.json', import.meta.url), 'utf8')
);

describe('Общие контракты Go ↔ TS', () => {
  it.each(fixtures.appStates)('AppState $id проходит window.api без изменения null, массивов и UTF-8', async ({ expected }) => {
    const raw = structuredClone(expected);
    const b = {
      app: async () => ({ State: async () => raw }),
      shell: async () => ({ FileBase: async () => 'http://127.0.0.1:1' })
    } as unknown as Bindings;
    await expect(createApi(b).app.state()).resolves.toStrictEqual(expected);
    expect(raw).toStrictEqual(expected);
  });
});
