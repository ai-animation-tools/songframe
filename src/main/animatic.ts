/**
 * Аниматик: чтение сборки plan/animatic/latest, свежесть по реестру и фактическим входам, сборка заданием
 * (update_scene_views, затем build_animatic) и принятие в plan/production-status.json.
 * Принятие раньше записывал агент руками; здесь оно делается нажатием кнопки по тем же полям.
 */

import { animaticTexts } from '@shared/texts/animatic';
import { commonTexts } from '@shared/texts/common';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnimaticApproval, AnimaticShot, AnimaticView, JobInfo } from '@shared/types';
import { notificationsTexts } from '@shared/texts/notifications';
import type { Jobs } from './jobs';
import { animaticInputProblems, cachedFileDigest, type AnimaticManifest as Manifest } from './animatic-freshness';

const STATUS_FILE = join('plan', 'production-status.json');
const MANIFEST = join('plan', 'animatic', 'latest', 'manifest.json');
const CARDS_RECEIPT = join('plan', 'animatic', 'cards', 'manifest.json');

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface ProductionStatus {
  schema_version?: number;
  current_animatic?: string | null;
  current_animatic_status?: string;
  approved_animatic?: { manifest?: string; video?: string; video_sha256?: string } | null;
  [key: string]: unknown;
}

function readStatus(project: string): ProductionStatus {
  return (
    readJson<ProductionStatus>(join(project, STATUS_FILE)) ?? {
      schema_version: 1,
      current_animatic: null,
      current_animatic_status: 'none'
    }
  );
}

function registryDigest(project: string): string | null {
  const path = join(project, 'plan', 'scenes.json');
  return cachedFileDigest(path);
}

export function viewAnimatic(project: string): AnimaticView {
  const problems: string[] = [];
  const manifestPath = join(project, MANIFEST);
  const manifest = readJson<Manifest>(manifestPath);
  const registry = registryDigest(project);
  const status = readStatus(project);
  const cards = readJson<{ registry_sha256?: string }>(join(project, CARDS_RECEIPT));
  const cardsFresh = !!cards && !!registry && cards.registry_sha256 === registry;
  if (!registry) problems.push(commonTexts.scenario.requiredForWork);

  let shots: AnimaticShot[] = [];
  let built: AnimaticView['built'] = null;
  if (manifest && Array.isArray(manifest.shots)) {
    const videoPath = manifest.video_file ? join(project, 'plan', 'animatic', 'latest', manifest.video_file) : null;
    const videoExists = !!videoPath && existsSync(videoPath);
    if (!videoExists) problems.push(animaticTexts.main.videoMissing({ filename: manifest.video_file }));
    shots = manifest.shots.map((s) => ({
      id: s.id,
      title: s.title ?? s.id,
      original: s.original ?? '',
      sequence: s.sequence ?? '',
      sequenceTitle: s.sequence_title ?? '',
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      frames: Number(s.frames ?? 0),
      action: s.action ?? '',
      camera: s.camera ?? '',
      lipsync: !!s.lipsync,
      media: s.media ?? 'card',
      cardPath: s.media !== 'video' && s.path ? join(project, s.path) : null,
      lastCardPath: s.media === 'keyframes' && s.path_last ? join(project, s.path_last) : null
    }));
    const inputProblems = animaticInputProblems(project, manifest);
    problems.push(...inputProblems);
    built = {
      videoPath: videoExists ? videoPath : null,
      manifestPath,
      videoSha256: manifest.video_sha256 ?? null,
      duration: Number(manifest.video_duration ?? 0),
      totalFrames: Number(manifest.total_frames ?? 0),
      builtAt: statSync(manifestPath).mtime.toISOString(),
      fresh: !!registry && manifest.scene_registry_sha256 === registry && videoExists && !inputProblems.length,
      counts: {
        video: shots.filter((s) => s.media === 'video').length,
        cards: shots.filter((s) => s.media === 'card').length,
        keyframes: shots.filter((s) => s.media === 'keyframes').length
      }
    };
    if (!registry || manifest.scene_registry_sha256 !== registry) problems.push(animaticTexts.main.registryChanged);
  } else if (existsSync(manifestPath)) {
    problems.push(animaticTexts.main.manifestCorrupt);
  }

  const approvedSha = status.approved_animatic?.video_sha256 ?? null;
  const approval: AnimaticApproval = {
    status: status.current_animatic_status === 'approved' ? 'approved' : status.current_animatic_status === 'review' ? 'review' : 'none',
    approvedSha256: approvedSha,
    /** Принята именно свежая сборка: прежнее согласование остаётся в истории после изменения входов. */
    current: status.current_animatic_status === 'approved' && !!built?.fresh && !!built?.videoSha256 && approvedSha === built.videoSha256
  };
  // После замены latest отметка прежнего результата остаётся в истории принятия.
  // Обычное ожидание повторного просмотра отражает approval, отдельное предупреждение не нужно.
  return { built, shots, approval, cardsFresh, problems };
}

export class Animatic {
  constructor(private readonly jobs: Jobs) {}

  /** Карточки должны быть свежими по реестру, иначе build_animatic остановится; обновление представлений идёт первым шагом. */
  build(project: string, planOnly: boolean): JobInfo {
    // У нового проекта ещё нет сценария: сообщаем об этом до создания задания и запуска Python.
    if (!statSync(join(project, 'plan', 'scenes.json'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(commonTexts.scenario.requiredForWork);
    }
    const steps = [
      { tool: 'update_scene_views', args: [], label: animaticTexts.main.updateViewsStep },
      { tool: 'build_animatic', args: planOnly ? ['--plan-only'] : [], label: planOnly ? animaticTexts.main.checkInputsStep : animaticTexts.main.buildStep }
    ];
    return this.jobs.start('animatic', planOnly ? notificationsTexts.animaticCheckTitle : animaticTexts.main.buildTitle, project, steps);
  }
}

/** Принятие текущей сборки или возврат на просмотр; прочие поля production-status.json сохраняются. */
export function setAnimaticStatus(project: string, status: 'approved' | 'review'): AnimaticView {
  const view = viewAnimatic(project);
  if (!view.built?.videoPath || !view.built.videoSha256) throw new Error(animaticTexts.main.buildRequired);
  if (status === 'approved' && !view.built.fresh) throw new Error(animaticTexts.main.freshBuildRequired);
  const data = readStatus(project);
  const manifest = readJson<Manifest>(join(project, MANIFEST));
  const next: ProductionStatus = {
    ...data,
    current_animatic: MANIFEST.split('\\').join('/'),
    current_animatic_status: status
  };
  if (status === 'approved') {
    next.approved_animatic = {
      manifest: MANIFEST.split('\\').join('/'),
      video: `plan/animatic/latest/${manifest?.video_file ?? ''}`,
      video_sha256: view.built.videoSha256
    };
  } else {
    delete next.approved_animatic;
  }
  writeFileSync(join(project, STATUS_FILE), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return viewAnimatic(project);
}
