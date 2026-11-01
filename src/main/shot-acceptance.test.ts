/** Принятие плана по отпечатку постановки: сверка с Python, устаревание, затронутые планы и режимы сохранения. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { acceptedFingerprints, projectFingerprints, shotAcceptance } from './shot-acceptance';
import { computeStatus } from './status';
import { readAcceptedVideoSnapshot, readSourceVideoSnapshot } from './derived-source';
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
  const sourceManifest = JSON.parse(readFileSync(join(project, 'assets/shots/M02/manifest.json'), 'utf8'));
  writeFileSync(
    join(project, 'assets/shots/M05/manifest.json'),
    JSON.stringify({
      schema_version: 1,
      shot: 'M05',
      kind: 'derived_video',
      generation: {
        source_shot: 'M02',
        source_scene_sha256: projectFingerprints(project, registry()).M02,
        source_accepted_video_sha256: sourceManifest.accepted_edit.video.sha256
      }
    })
  );
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
    expect(status.problems).toContain('Постановка изменена после приёмки: M02. Нужно новое производство этих планов.');
    expect(status.problems).toContain('Не подтверждена актуальность производных планов: M05. Проверьте версию источника и приёмку этих планов.');
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
    expect(states()).toMatchObject({ M01: 'stale', M02: 'completed', M05: 'stale' });
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

describe('снимок источника производного плана', () => {
  const sourcePath = (): string => join(project, 'assets/shots/M02/manifest.json');
  const changeSource = (): void => {
    const manifest = JSON.parse(readFileSync(sourcePath(), 'utf8'));
    const bytes = Buffer.from('Новый выбранный клип при прежней постановке');
    writeFileSync(join(project, 'assets/shots/M02/replacement.mp4'), bytes);
    manifest.accepted_edit.video = { path: 'replacement.mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(sourcePath(), JSON.stringify(manifest));
  };
  const assertPythonParity = (): void => {
    const output = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        'import json,sys; from tools.scene_registry.scene_registry import project_shot_acceptance; print(json.dumps(project_shot_acceptance(sys.argv[1])))',
        project
      ],
      { cwd: REPO, encoding: 'utf8' }
    );
    expect(Object.fromEntries(shotAcceptance(project, registry()).accepted)).toEqual(JSON.parse(output));
  };

  const targetPath = (): string => join(project, 'assets/shots/M05/manifest.json');
  const reviewPath = (): string => join(project, 'plan/production-status.json');
  const writeReview = (review: unknown): void => {
    const status = JSON.parse(readFileSync(reviewPath(), 'utf8'));
    status.shots.M05.source_review = review;
    writeFileSync(reviewPath(), JSON.stringify(status));
  };
  const explicitReview = (): Record<string, string> => {
    const manifest = JSON.parse(readFileSync(targetPath(), 'utf8'));
    const bytes = Buffer.from('Уже принятый производный клип, подтверждённый пользователем.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(project, 'assets/shots/M05/video.mp4'), bytes);
    manifest.accepted_edit = { video: { path: 'video.mp4', sha256: hash } };
    manifest.generation.source_scene_sha256 = null;
    manifest.generation.source_accepted_video_sha256 = 'b'.repeat(64);
    writeFileSync(targetPath(), JSON.stringify(manifest));
    const source = JSON.parse(readFileSync(sourcePath(), 'utf8'));
    const review = {
      source_shot: 'M02',
      source_scene_sha256: projectFingerprints(project, registry()).M02,
      source_accepted_video_sha256: source.accepted_edit.video.sha256,
      accepted_video_sha256: hash
    };
    writeReview(review);
    return review;
  };

  it('явное подтверждение существующего клипа учитывается отдельно от неизвестного исторического generation', () => {
    const review = explicitReview();
    const before = readFileSync(targetPath(), 'utf8');
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('completed');
    assertPythonParity();
    expect(readFileSync(targetPath(), 'utf8')).toBe(before);
    expect(JSON.parse(before).generation).toMatchObject({ source_scene_sha256: null, source_accepted_video_sha256: 'b'.repeat(64) });
    expect(readAcceptedVideoSnapshot(project, 'M05')?.acceptedVideoSha256).toBe(review.accepted_video_sha256);
    expect(readSourceVideoSnapshot(project, 'M05')).toBeNull();
    // Переподтверждение неизменных байтов и постановки сохраняет явное решение пользователя.
    stampAcceptedShots(project, ['M05']);
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('completed');
    assertPythonParity();
    expect(JSON.parse(readFileSync(reviewPath(), 'utf8')).shots.M05.source_review).toEqual(review);
  });

  it('изменение принятого клипа источника не подменяет сохранённое подтверждение', () => {
    explicitReview();
    changeSource();
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_changed');
    assertPythonParity();
    stampAcceptedShots(project, ['M02']);
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_changed');
    assertPythonParity();
  });

  it('новая постановка источника после её приёмки требует нового явного подтверждения', () => {
    const review = explicitReview();
    const data = registry();
    scene(data.scenes, 'M02').action += ' Другое действие.';
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(data));
    stampAcceptedShots(project, ['M02', 'M05']);
    expect(shotAcceptance(project, data).reasons.get('M05')).toBe('source_changed');
    assertPythonParity();
    expect(JSON.parse(readFileSync(reviewPath(), 'utf8')).shots.M05.source_review).toEqual(review);
  });

  it.each(['bytes', 'descriptor', 'missing', 'outside'] as const)('подтверждение не скрывает замену или поломку собственного клипа: %s', (change) => {
    explicitReview();
    const manifest = JSON.parse(readFileSync(targetPath(), 'utf8'));
    const path = join(project, 'assets/shots/M05/video.mp4');
    if (change === 'bytes') writeFileSync(path, 'Подменённые байты');
    else if (change === 'descriptor') {
      const bytes = Buffer.from('Другой корректно описанный принятый клип');
      writeFileSync(join(project, 'assets/shots/M05/new.mp4'), bytes);
      manifest.accepted_edit.video = { path: 'new.mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
    } else if (change === 'missing') manifest.accepted_edit.video.path = 'нет-файла.mp4';
    else manifest.accepted_edit.video.path = '../M02/video.mp4';
    writeFileSync(targetPath(), JSON.stringify(manifest));
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_receipt_missing');
    assertPythonParity();
  });

  it('подтверждение не отменяет изменение собственной постановки или связи derived_from', () => {
    const review = explicitReview();
    const data = registry();
    scene(data.scenes, 'M05').action += ' Новое действие.';
    expect(shotAcceptance(project, data).reasons.get('M05')).toBe('scene_changed');
    const original = registry();
    delete scene(original.scenes, 'M05').derived_from;
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(original));
    stampAcceptedShots(project, ['M05']);
    expect(shotAcceptance(project, original).reasons.get('M05')).toBe('derived_link_changed');
    assertPythonParity();
    writeReview({ ...review, source_shot: 'M01' });
    // Связь восстанавливаем без изменения квитанции: подтверждён другой источник.
    scene(original.scenes, 'M05').derived_from = { shot: 'M02' };
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(original));
    stampAcceptedShots(project, ['M05']);
    expect(shotAcceptance(project, original).reasons.get('M05')).toBe('derived_link_changed');
    assertPythonParity();
  });

  it.each(['null', 'incomplete', 'extra', 'hash'] as const)('некорректное явное подтверждение не заменяется поколенческим снимком: %s', (kind) => {
    const review = explicitReview();
    // Даже пригодный снимок generation не является fallback для повреждённого явно сохранённого решения.
    const manifest = JSON.parse(readFileSync(targetPath(), 'utf8'));
    manifest.generation.source_scene_sha256 = review.source_scene_sha256;
    manifest.generation.source_accepted_video_sha256 = review.source_accepted_video_sha256;
    writeFileSync(targetPath(), JSON.stringify(manifest));
    if (kind === 'null') writeReview(null);
    else if (kind === 'incomplete') {
      const { accepted_video_sha256: _ignored, ...partial } = review;
      writeReview(partial);
    } else if (kind === 'extra') writeReview({ ...review, approved: true });
    else writeReview({ ...review, accepted_video_sha256: 'не SHA-256' });
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_receipt_missing');
    assertPythonParity();
  });

  it('замена клипа без изменения постановки навсегда устаревает до новой сборки и приёмки', () => {
    assertPythonParity();
    changeSource();
    expect(shotAcceptance(project, registry()).accepted.get('M02')).toBe('completed');
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_changed');
    stampAcceptedShots(project, ['M02']);
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('stale');
    assertPythonParity();
  });

  it.each(['missing', 'corrupt', 'manifest'] as const)('не считает готовым производный план при %s источнике', (kind) => {
    const manifest = JSON.parse(readFileSync(sourcePath(), 'utf8'));
    const video = join(project, 'assets/shots/M02', manifest.accepted_edit.video.path);
    if (kind === 'missing') rmSync(video);
    else if (kind === 'corrupt') writeFileSync(video, 'Испорченное видео');
    else rmSync(sourcePath());
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('stale');
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_unavailable');
    assertPythonParity();
  });

  it('не зависит от посторонних полей манифеста источника', () => {
    const manifest = JSON.parse(readFileSync(sourcePath(), 'utf8'));
    manifest.note = 'Техническая пометка без изменения выбранного материала';
    writeFileSync(sourcePath(), JSON.stringify(manifest));
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('completed');
    assertPythonParity();
  });

  it('повторная приёмка изменённой постановки источника не обновляет старый снимок', () => {
    saveScenesWithMode(
      project,
      edit((scenes) => (scene(scenes, 'M02').action += ' Новое действие.')),
      'production'
    );
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('stale');
    stampAcceptedShots(project, ['M02']);
    expect(shotAcceptance(project, registry()).accepted.get('M02')).toBe('completed');
    expect(shotAcceptance(project, registry()).accepted.get('M05')).toBe('stale');
    assertPythonParity();
  });

  it('разрешает источник позже по шкале и устаревает после удаления связи', () => {
    const data = registry();
    delete scene(data.scenes, 'M05').derived_from;
    scene(data.scenes, 'M01').derived_from = { shot: 'M02' };
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(data));
    const manifest = JSON.parse(readFileSync(join(project, 'assets/shots/M01/manifest.json'), 'utf8'));
    manifest.kind = 'derived_video';
    manifest.generation.source_shot = 'M02';
    manifest.generation.source_scene_sha256 = projectFingerprints(project, data).M02;
    manifest.generation.source_accepted_video_sha256 = JSON.parse(readFileSync(sourcePath(), 'utf8')).accepted_edit.video.sha256;
    writeFileSync(join(project, 'assets/shots/M01/manifest.json'), JSON.stringify(manifest));
    stampAcceptedShots(project, ['M01', 'M02', 'M05']);
    expect(shotAcceptance(project, data).accepted.get('M01')).toBe('completed');
    assertPythonParity();
    delete scene(data.scenes, 'M01').derived_from;
    writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(data));
    stampAcceptedShots(project, ['M01']);
    expect(shotAcceptance(project, data).reasons.get('M01')).toBe('derived_link_changed');
    assertPythonParity();
  });

  it('не приписывает историческому null сегодняшнюю постановку', () => {
    const path = join(project, 'assets/shots/M05/manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.generation.source_scene_sha256 = null;
    const before = JSON.stringify(manifest);
    writeFileSync(path, before);
    expect(shotAcceptance(project, registry()).reasons.get('M05')).toBe('source_receipt_missing');
    expect(readFileSync(path, 'utf8')).toBe(before);
    assertPythonParity();
  });
});
