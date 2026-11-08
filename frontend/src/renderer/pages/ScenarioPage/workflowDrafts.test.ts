import { describe, expect, it } from 'vitest';
import type { ScenarioView, ScenesFile, TreatmentFile } from '@shared/types';
import { scenarioTexts } from '@shared/texts/scenario';
import { scenesSavedView, workflowUpdatedView } from './workflowDrafts';

const treatment = (logline: string): TreatmentFile => ({ schema_version: 1, logline, sequences: [] });
const scenes = (visual_direction: string): ScenesFile => ({
  schema_version: 1,
  fps: 30,
  audio: { path: 'source/song.mp3', end_seconds: '10' },
  references: {},
  visual_direction,
  sequences: [],
  scenes: []
});
const view = (logline: string, direction: string): ScenarioView => ({
  cast: null,
  treatment: treatment(logline),
  scenes: scenes(direction),
  timing: null,
  lyrics: [],
  duration: 10,
  trackPath: null,
  problems: [],
  referencesStale: false
});

/** Сценарный Apply не должен менять базу сравнения независимого несохранённого черновика. */
describe('workflowUpdatedView', () => {
  it('после treatment сохраняет прежнюю базу сцен и обновляет кастинг с трактовкой', () => {
    const previous = view('раньше', 'сохранённые сцены');
    const next = view('предложение', 'постороннее изменение на диске');
    const updated = workflowUpdatedView(previous, next, 'treatment');
    expect(updated.scenes).toBe(previous.scenes);
    expect(updated.treatment).toBe(next.treatment);
    expect(updated.cast).toBe(next.cast);
    expect(JSON.stringify(scenes('несохранённый черновик')) !== JSON.stringify(updated.scenes)).toBe(true);
  });

  it.each(['scenes', 'revise'] as const)('после %s сохраняет базу трактовки другой вкладки', (pass) => {
    const previous = view('сохранённая трактовка', 'раньше');
    const next = view('постороннее изменение на диске', 'предложение');
    const updated = workflowUpdatedView(previous, next, pass);
    expect(updated.treatment).toBe(previous.treatment);
    expect(updated.scenes).toBe(next.scenes);
    expect(JSON.stringify(treatment('несохранённый черновик')) !== JSON.stringify(updated.treatment)).toBe(true);
  });
});

/** Запись реестра обновляет карту references в Go: предупреждение о расхождении с кастингом больше не верно. */
describe('scenesSavedView', () => {
  it('снимает признак устаревшей карты и только её предупреждение', () => {
    const stale = { ...view('трактовка', 'старые сцены'), referencesStale: true, problems: ['Другое.', scenarioTexts.main.referencesRefresh] };
    const saved = scenes('сохранённые сцены');
    expect(scenesSavedView(stale, saved)).toEqual({ ...stale, scenes: saved, referencesStale: false, problems: ['Другое.'] });
    expect(scenesSavedView(null, saved)).toBeNull();
  });
});
