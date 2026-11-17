import { describe, expect, it } from 'vitest';
import type { ScenarioView, ScenesFile } from '@shared/types';
import { scenarioTexts } from '@shared/texts/scenario';
import { scenesSavedView } from './workflowDrafts';

const scenes = (visual_direction: string, logline = ''): ScenesFile => ({
  schema_version: 1,
  fps: 30,
  audio: { path: 'source/song.mp3', end_seconds: '10' },
  references: {},
  visual_direction,
  logline,
  sequences: [],
  scenes: []
});
const view = (logline: string, direction: string): ScenarioView => ({
  cast: null,
  scenes: scenes(direction, logline),
  timing: null,
  lyrics: [],
  duration: 10,
  trackPath: null,
  problems: [],
  referencesStale: false
});

/** Запись сценария обновляет карту references в Go: предупреждение о расхождении с кастингом больше не верно. */
describe('scenesSavedView', () => {
  it('снимает признак устаревшей карты и только её предупреждение', () => {
    const stale = { ...view('логлайн', 'старые сцены'), referencesStale: true, problems: ['Другое.', scenarioTexts.main.referencesRefresh] };
    const saved = scenes('сохранённые сцены');
    expect(scenesSavedView(stale, saved)).toEqual({ ...stale, scenes: saved, referencesStale: false, problems: ['Другое.'] });
    expect(scenesSavedView(null, saved)).toBeNull();
  });
});
