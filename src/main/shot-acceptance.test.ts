/** Принятие плана по отпечатку постановки: сверка с Python, устаревание, затронутые планы и режимы сохранения. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScenesFile } from '@shared/types';
import { initialStates, readCast } from './cast';
import { buildBrief } from './scenario';
import { Production, readPackage, SCENE_CHANGED, viewProduction } from './production';
import { saveScenesWithMode, scenesSaveImpact } from './scenario-save';
import { sceneFingerprints } from './scene-fingerprint';
import { acceptedFingerprints, projectFingerprints } from './shot-acceptance';
import { computeStatus } from './status';
import { stampAcceptedShots } from './testing/accepted-shots';

const REPO = resolve(__dirname, '../..');
let work: string;
let project: string;

const registry = (): ScenesFile => JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8')) as ScenesFile;
const states = (): Record<string, string> => Object.fromEntries(viewProduction(project).shots.map((shot) => [shot.id, shot.state]));
const edit = (change: (scenes: ScenesFile['scenes']) => void): ScenesFile => {
  const draft = registry();
  change(draft.scenes);
  return draft;
};
const scene = (scenes: ScenesFile['scenes'], id: string): ScenesFile['scenes'][number] => scenes.find((item) => item.id === id)!;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-acceptance-'));
  project = join(work, 'sample-project');
  cpSync(join(REPO, 'tools/testdata/sample-project'), project, { recursive: true });
  // M05 собирается из материала M02: производный комплект устаревает вместе с источником.
  mkdirSync(join(project, 'assets/shots/M05'));
  writeFileSync(join(project, 'assets/shots/M05/manifest.json'), JSON.stringify({ shot: 'M05', kind: 'derived_video' }));
  stampAcceptedShots(project, ['M01', 'M02', 'M05']);
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('отпечаток постановки', () => {
  it('совпадает с scene_fingerprint инструментов Python на проекте-образце', () => {
    const scenes = JSON.parse(readFileSync(join(REPO, 'tools/testdata/sample-project/plan/scenes.json'), 'utf8')) as ScenesFile;
    const cast = readCast(join(REPO, 'tools/testdata/sample-project')) || null;
    const expected = JSON.parse(readFileSync(join(REPO, 'tools/testdata/scene-fingerprints.json'), 'utf8'));
    expect(sceneFingerprints(scenes, initialStates(cast))).toEqual(expected);
  });
});

describe('принятие плана', () => {
  it('принятый план устаревает после правки постановки, производный — вместе с источником', () => {
    expect(states()).toMatchObject({ M01: 'completed', M02: 'completed', M05: 'completed' });
    saveScenesWithMode(
      project,
      edit((scenes) => (scene(scenes, 'M02').action += ' Лодка качается.')),
      'production'
    );
    expect(states()).toMatchObject({ M01: 'completed', M02: 'stale', M05: 'stale' });
    const m02 = viewProduction(project).shots.find((shot) => shot.id === 'M02')!;
    expect(m02.stageLabel).toBe('принят по прежней постановке: нужно новое производство');
    const status = computeStatus(project);
    expect(status.checks.shotsDone).toBe(1);
    expect(status.problems).toContain('Постановка изменена после приёмки: M02, M05. Нужно новое производство этих планов.');
  });

  it('пакет после правки постановки требует пересогласования', () => {
    saveScenesWithMode(
      project,
      edit((scenes) => (scene(scenes, 'M03').camera += ', медленнее')),
      'production'
    );
    const m03 = viewProduction(project).shots.find((shot) => shot.id === 'M03')!;
    expect(m03.state).toBe('unknown');
    expect(m03.packages[0]).toMatchObject({ sceneChanged: true, problems: [SCENE_CHANGED] });
  });

  it('устаревший неотправленный пакет можно оставить для текущей постановки', () => {
    saveScenesWithMode(
      project,
      edit((scenes) => (scene(scenes, 'M03').camera += ', медленнее')),
      'production'
    );
    const dir = join(project, 'plan/batches/M03-attempt-01');
    const before = readFileSync(join(dir, 'workflow.json'), 'utf8');
    new Production(null, { get: () => undefined, list: () => [] } as never).keepPackageForScene(project, dir);
    const after = readFileSync(join(dir, 'workflow.json'), 'utf8');
    expect(readPackage(project, dir)).toMatchObject({ sceneChanged: false, problems: [] });
    // Меняется только отпечаток постановки, остальной файл прежний.
    expect(after.replace(JSON.parse(after).scene_sha256, '')).toBe(before.replace(JSON.parse(before).scene_sha256, ''));
    expect(() => new Production(null, { get: () => undefined, list: () => [] } as never).keepPackageForScene(project, dir)).toThrow('не менялась');
  });
});

describe('источники врезки', () => {
  it('у каждого значения указан кастинг или план с фазой, где оно задано', () => {
    const cast = readCast(project) || null;
    const brief = buildBrief(registry(), cast, 'M04', 'before', null);
    expect(brief.sources.mira.position).toEqual({ kind: 'plan', shot: 'M04', phase: 'before' });
    expect(brief.sources.boat.dirt).toEqual({ kind: 'plan', shot: 'M03', phase: 'after' });
    // Не изменённые планами значения приходят из начального состояния кастинга.
    expect(brief.sources.mira.clothes_condition).toEqual({ kind: 'cast' });
    expect(brief.sources.world.weather).toEqual({ kind: 'cast' });
    // До правок первого кадра M04 положение Миры пришло из кастинга; итог плана наследует первый кадр.
    expect(brief.inherited.mira.position).toBe('у края причала');
    expect(brief.state.mira.position).toBe('стоит у края причала');
    expect(buildBrief(registry(), cast, 'M04', 'after', null).inherited).toEqual(brief.state);
    // Каждое значение состояния имеет источник.
    for (const [entity, attributes] of Object.entries(brief.state)) expect(Object.keys(brief.sources[entity])).toEqual(Object.keys(attributes));
  });
});

describe('затронутые планы', () => {
  it('своя постановка и производный план', () => {
    const impact = scenesSaveImpact(
      project,
      edit((scenes) => (scene(scenes, 'M02').action += ' Лодка качается.'))
    );
    expect(impact.shots).toEqual([
      { id: 'M02', reason: 'изменена постановка плана', state: 'completed', produced: true },
      { id: 'M05', reason: 'собирается из материала M02', state: 'completed', produced: true }
    ]);
  });

  // M03 сам задаёт boat.dirt, поэтому M04 правка M01 не затрагивает.
  it('унаследованное состояние', () => {
    const impact = scenesSaveImpact(
      project,
      edit((scenes) => (scene(scenes, 'M01').state_changes = { after: { boat: { dirt: 'в иле' } } }))
    );
    expect(impact.shots.map((shot) => [shot.id, shot.reason, shot.produced])).toEqual([
      ['M01', 'изменена постановка плана', true],
      ['M02', 'изменилось состояние, унаследованное от M01', true],
      ['M03', 'изменилось состояние, унаследованное от M02', true],
      ['M05', 'изменилось состояние, унаследованное от M02', true]
    ]);
  });

  it('сдвиг границы меняет оба соседних плана', () => {
    const impact = scenesSaveImpact(
      project,
      edit((scenes) => {
        scene(scenes, 'M01').end_frame_exclusive = 210;
        scene(scenes, 'M02').start_frame = 210;
      })
    );
    expect(impact.shots.map((shot) => [shot.id, shot.reason])).toEqual([
      ['M01', 'сдвинуты границы плана'],
      ['M02', 'сдвинуты границы плана'],
      ['M05', 'собирается из материала M02']
    ]);
  });

  it('черновик без изменений постановки ничего не затрагивает', () => {
    expect(scenesSaveImpact(project, registry()).shots).toEqual([]);
  });
});

describe('сохранение без производства', () => {
  it('оставляет в силе принятые и подготовленные планы, но не отменяет прежнюю сюжетную правку', () => {
    saveScenesWithMode(
      project,
      edit((scenes) => (scene(scenes, 'M01').action += ' Ветер усиливается.')),
      'production'
    );
    expect(states().M01).toBe('stale');
    const workflowPath = join(project, 'plan/batches/M03-attempt-01/workflow.json');
    const workflowBefore = readFileSync(workflowPath, 'utf8');
    const stampedBefore = acceptedFingerprints(project);

    saveScenesWithMode(
      project,
      edit((scenes) => {
        scene(scenes, 'M01').notes = 'опечатка исправлена';
        scene(scenes, 'M02').action = scene(scenes, 'M02').action.replace(/\.$/, '!');
        scene(scenes, 'M03').camera += ' ';
      }),
      'keep'
    );
    const fingerprints = projectFingerprints(project, registry());
    expect(states()).toMatchObject({ M01: 'stale', M02: 'completed', M05: 'completed' });
    expect(acceptedFingerprints(project)).toMatchObject({ M01: stampedBefore.M01, M02: fingerprints.M02 });
    // В workflow.json пакета меняется только отпечаток, остальной текст файла сохраняется байт в байт.
    const workflowAfter = readFileSync(workflowPath, 'utf8');
    expect(JSON.parse(workflowAfter).scene_sha256).toBe(fingerprints.M03);
    expect(workflowAfter.replace(fingerprints.M03, '')).toBe(workflowBefore.replace(JSON.parse(workflowBefore).scene_sha256, ''));
    expect(viewProduction(project).shots.find((shot) => shot.id === 'M03')!.packages[0].problems).toEqual([]);
  });

  it('не записывает реестр, если файл принятых отпечатков повреждён', () => {
    const before = readFileSync(join(project, 'plan/scenes.json'), 'utf8');
    writeFileSync(join(project, 'plan/production-status.json'), '{');
    expect(() =>
      saveScenesWithMode(
        project,
        edit((scenes) => (scene(scenes, 'M02').notes = 'опечатка')),
        'keep'
      )
    ).toThrow(/повреждён/);
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe(before);
  });

  it('отвергает неизвестный режим', () => {
    expect(() => saveScenesWithMode(project, registry(), 'other' as 'keep')).toThrow(/режим/);
  });
});
