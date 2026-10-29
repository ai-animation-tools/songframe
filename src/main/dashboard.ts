/**
 * Дашборд сцен: по каждому плану реестра собирается всё, что о нём известно в проекте, в одну карточку:
 * постановка и строка песни, положение на шкале, комплект в assets (оригинал против принятого монтажа,
 * рецепт, промпт, входы), пакеты с опорами, карточка аниматика, состояние героев до и после.
 * Ничего не пишет: это чтение файлов и переиспользование резолвера состояния.
 */

import { FPS } from '@shared/video';
import { mediaProviderTitles } from '@shared/media-providers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DashboardShot, DashboardView, EntityState, ScenesFile } from '@shared/types';
import { readCast } from './cast';
import { buildBrief } from './scenario';
import { viewProduction } from './production';

const IMAGE = /\.(png|jpe?g|webp)$/i;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface Descriptor {
  path?: string;
  root?: string;
  role?: string;
  slot?: string;
}

interface AssetManifest {
  shot?: string;
  generation?: {
    original?: Descriptor;
    original_media?: { width?: number; height?: number; r_frame_rate?: string; duration?: string; nb_frames?: string };
    prompt?: Descriptor;
    request?: Descriptor;
    inputs?: Descriptor[];
    lipsync?: boolean;
    audio?: Descriptor | null;
  };
  accepted_edit?: {
    video?: Descriptor;
    frames?: number;
    duration_seconds?: number;
    source_interval_seconds?: [number, number] | null;
    still_source_time_seconds?: number | null;
    speed?: { factor?: number; ratio?: string };
    hold_first_seconds?: number;
    hold_last_seconds?: number;
    processing_note?: string;
  };
}

/** Путь дескриптора комплекта: без root или с root asset от папки сцены, с root source от папки source. */
function descriptorPath(project: string, assetDir: string, item: Descriptor | undefined | null): string | null {
  if (!item?.path) return null;
  const base = item.root === 'source' ? join(project, 'source') : assetDir;
  const path = join(base, item.path);
  return existsSync(path) ? path : null;
}

function readText(path: string | null): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readAsset(project: string, sid: string, fps: number): DashboardShot['asset'] {
  const dir = join(project, 'assets', 'shots', sid);
  const manifest = readJson<AssetManifest>(join(dir, 'manifest.json'));
  if (!manifest) return null;
  const generation = manifest.generation ?? {};
  const edit = manifest.accepted_edit ?? {};
  const request = readJson<{ model?: string; parameters?: Record<string, unknown>; provider?: string }>(descriptorPath(project, dir, generation.request) ?? '');
  const inputs = (generation.inputs ?? [])
    .map((item) => ({ path: descriptorPath(project, dir, item), role: item.role ?? item.slot ?? '' }))
    .filter((item): item is { path: string; role: string } => !!item.path && IMAGE.test(item.path));
  const media = generation.original_media;
  return {
    dir,
    video: descriptorPath(project, dir, edit.video),
    original: descriptorPath(project, dir, generation.original),
    originalMedia: media
      ? `${media.width ?? '?'}×${media.height ?? '?'}, ${media.r_frame_rate ?? '?'} кадр/с, ${media.nb_frames ?? '?'} кадров, ${Number(media.duration ?? 0).toFixed(2)} с`
      : null,
    edit: {
      frames: Number(edit.frames ?? 0),
      duration: Number(edit.duration_seconds ?? (edit.frames ?? 0) / fps),
      sourceInterval: edit.source_interval_seconds ?? null,
      stillAt: edit.still_source_time_seconds ?? null,
      speed: edit.speed?.ratio ?? (edit.speed?.factor ? String(edit.speed.factor) : '1'),
      holdFirst: Number(edit.hold_first_seconds ?? 0),
      holdLast: Number(edit.hold_last_seconds ?? 0),
      note: edit.processing_note ?? ''
    },
    prompt: readText(descriptorPath(project, dir, generation.prompt)),
    request: request ? { provider: request.provider ?? mediaProviderTitles('video'), model: request.model ?? '', parameters: request.parameters ?? {} } : null,
    inputs,
    lipsync: !!generation.lipsync,
    audio: descriptorPath(project, dir, generation.audio)
  };
}

export function viewDashboard(project: string, toolsRoot: string | null): DashboardView {
  const scenes = readJson<ScenesFile>(join(project, 'plan', 'scenes.json'));
  if (!scenes)
    return {
      shots: [],
      summary: { total: 0, completed: 0, stale: 0, progress: 0, planned: 0, duration: 0, completedSeconds: 0 },
      problems: ['Сначала нужен сценарий. Создайте его на странице «Сценарий».']
    };
  // Частота кадров принадлежит реестру сцен (schema требует 30), приложение её не выбирает и не хранит отдельно.
  const fps = Number(scenes.fps) || FPS;
  const production = viewProduction(project);
  const byId = new Map(production.shots.map((s) => [s.id, s]));
  const cast = readCast(project) || null;
  const titles = new Map(scenes.sequences.map((s) => [s.id, s.title]));
  const animatic = readJson<{ scene_registry_sha256?: string; shots?: { id: string; media?: string }[] }>(
    join(project, 'plan', 'animatic', 'latest', 'manifest.json')
  );
  const animaticMedia = new Map((animatic?.shots ?? []).map((s) => [s.id, s.media ?? 'card']));
  const problems = [...production.problems];

  // Строки врезки непрерывности: имя сущности и подписи свойств из словаря, а не ключи и коды.
  const brief = (sid: string, phase: 'before' | 'after'): { state: EntityState; lines: string[]; checklist: string[] } | null => {
    try {
      const result = buildBrief(scenes, cast, sid, phase, toolsRoot);
      const body = result.text.split('\n').slice(2);
      const end = body.indexOf('');
      return { state: result.state, lines: end === -1 ? body : body.slice(0, end), checklist: result.checklist };
    } catch (error) {
      problems.push(`${sid}: состояние не вычислено: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const shots: DashboardShot[] = scenes.scenes.map((scene) => {
    const prod = byId.get(scene.id);
    const asset = readAsset(project, scene.id, fps);
    const packages = prod?.packages ?? [];
    const latest = packages[0] ?? null;
    const card = join(project, 'plan', 'animatic', 'cards', `${scene.id}.png`);
    const keyframes = asset?.inputs.length
      ? asset.inputs.map((i) => ({ imagePath: i.path, label: i.role || 'вход запроса', approved: true }))
      : (latest?.keyframes ?? [])
          .filter((k) => k.imagePath)
          .map((k) => ({ imagePath: k.imagePath!, label: `${k.id} · ${k.role}${k.note ? ` · ${k.note}` : ''}`, approved: k.approved }));
    const references = scene.references.map((id) => {
      const ref = scenes.references[id];
      const path = ref?.path ? join(project, ref.path) : null;
      return { id, name: ref?.short_name ?? ref?.name ?? id, imagePath: path && existsSync(path) ? path : null };
    });
    return {
      id: scene.id,
      title: scene.title ?? titles.get(scene.sequence) ?? scene.sequence,
      sequenceTitle: titles.get(scene.sequence) ?? scene.sequence,
      original: scene.original,
      start: scene.start_frame / fps,
      end: scene.end_frame_exclusive / fps,
      frames: scene.end_frame_exclusive - scene.start_frame,
      camera: scene.camera,
      action: scene.action,
      continuity: scene.continuity,
      notes: scene.notes ?? '',
      lipsync: scene.lipsync,
      references,
      state: prod?.state ?? 'planned',
      stageLabel: prod?.stageLabel ?? 'постановка есть, работа не начата',
      asset,
      package: latest
        ? {
            dir: latest.dir,
            stageLabel: latest.stageLabel,
            prompt: latest.prompt?.text ?? null,
            request: latest.request ? { model: latest.request.model, parameters: latest.request.parameters, downloads: latest.request.downloads } : null,
            preview: latest.preview
          }
        : null,
      packagesCount: packages.length,
      thumbnail: keyframes[0]?.imagePath ?? (existsSync(card) ? card : null),
      keyframes,
      cardPath: existsSync(card) ? card : null,
      animaticMedia: (animaticMedia.get(scene.id) as DashboardShot['animaticMedia']) ?? null,
      before: brief(scene.id, 'before'),
      after: brief(scene.id, 'after')
    };
  });
  const duration = shots.length ? shots[shots.length - 1].end : 0;
  const summary = {
    total: shots.length,
    completed: shots.filter((s) => s.state === 'completed').length,
    stale: shots.filter((s) => s.state === 'stale').length,
    progress: shots.filter((s) => s.state === 'progress' || s.state === 'unknown').length,
    planned: shots.filter((s) => s.state === 'planned').length,
    duration,
    completedSeconds: shots.filter((s) => s.state === 'completed').reduce((sum, s) => sum + (s.end - s.start), 0)
  };
  return { shots, summary, problems };
}
