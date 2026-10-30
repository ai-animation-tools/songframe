/** Свежесть сборки по её штатным source_hashes и текущему выбору принятых материалов. */
import { animaticTexts } from '@shared/texts/animatic';
import { FPS } from '@shared/video';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { animaticProjectInputsMatch } from './project-inputs';

interface FrameSource {
  id: string;
  role?: string;
  time_seconds?: number;
  path: string;
  sha256: string;
}
export interface AnimaticManifestShot {
  id: string;
  title?: string;
  original?: string;
  sequence?: string;
  sequence_title?: string;
  start?: string | number;
  end?: string | number;
  frames?: number;
  action?: string;
  camera?: string;
  lipsync?: boolean;
  media?: 'video' | 'card' | 'keyframes';
  path?: string;
  path_last?: string;
  sha256?: string;
  sha256_last?: string;
  keyframes?: FrameSource[];
  references?: string[];
  refs?: string[];
  card?: { primary_reference?: string };
}
export interface AnimaticManifest {
  total_frames?: number;
  video_duration?: number;
  scene_registry_sha256?: string;
  video_file?: string;
  video_sha256?: string;
  source_audio?: string;
  source_audio_sha256?: string;
  source_hashes?: Record<string, string>;
  project_inputs?: unknown;
  shots?: AnimaticManifestShot[];
}
interface CardsReceipt {
  registry_sha256?: string;
  reference_hashes?: Record<string, string>;
  cards?: Record<string, { sha256?: string; keyframes?: FrameSource[]; last?: { sha256?: string } }>;
}

const hashes = new Map<string, { identity: string; digest: string }>();

/** MP4 читается блоками один раз на identity; замена с прежними size/mtime видна по inode и ctime. */
export function cachedFileDigest(path: string): string | null {
  try {
    const entry = statSync(path, { bigint: true });
    if (!entry.isFile()) return null;
    const identity = [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(':');
    const cached = hashes.get(path);
    if (cached?.identity === identity) return cached.digest;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const descriptor = openSync(path, 'r');
    try {
      let count: number;
      while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    } finally {
      closeSync(descriptor);
    }
    const value = digest.digest('hex');
    // Кэш содержит только хеши, а не байты; ограничение не даёт копить пути старых открытых проектов.
    if (hashes.size >= 4096) hashes.clear();
    hashes.set(path, { identity, digest: value });
    return value;
  } catch {
    hashes.delete(path);
    return null;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function projectPath(project: string, name: string): string | null {
  const path = resolve(project, name);
  const local = relative(resolve(project), path);
  return isAbsolute(name) || local === '..' || local.startsWith(`..${sep}`) ? null : path;
}

/** Совпадает с approved_keyframes в update_scene_views: очередь, затем сортированные рабочие пакеты. */
function selectedFrames(project: string, shot: string): FrameSource[] | null {
  const batches = join(project, 'plan/batches');
  const candidates = [join(project, 'plan/awaiting', shot, 'workflow.json')];
  if (existsSync(batches)) {
    for (const item of readdirSync(batches, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (item.isDirectory()) candidates.push(join(batches, item.name, 'workflow.json'));
    }
  }
  for (const path of candidates) {
    const workflow = readJson<{ shot?: string; stage?: string; keyframes?: (FrameSource & { approved?: boolean })[] }>(path);
    if (workflow?.shot !== shot || workflow.stage === 'accepted' || !Array.isArray(workflow.keyframes) || !workflow.keyframes.length) continue;
    if (!workflow.keyframes.every((frame) => frame.approved && frame.path && cachedFileDigest(resolve(dirname(path), frame.path)))) continue;
    return workflow.keyframes.map((frame) => {
      const full = resolve(dirname(path), frame.path);
      return {
        id: frame.id,
        role: frame.role,
        time_seconds: frame.time_seconds,
        path: relative(project, full).split(sep).join('/'),
        sha256: cachedFileDigest(full)!
      };
    });
  }
  return null;
}

/** Проверяем фактически выбранные входы; альтернативы и незавершённые кандидаты не являются зависимостью сборки. */
export function animaticInputProblems(project: string, manifest: AnimaticManifest): string[] {
  const problems: string[] = [];
  const sources = manifest.source_hashes ?? {};
  const check = (name: string, digest: unknown): void => {
    const path = projectPath(project, name);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      problems.push(animaticTexts.main.inputHashMissing({ name }));
    } else if (!path || cachedFileDigest(path) !== digest) {
      problems.push(animaticTexts.main.inputChanged({ name }));
    }
  };
  // Snapshot отделяет настройки генерации и форматирование JSON от реальных входов аниматика.
  const projectFile = join(project, 'plan/project.json');
  const currentProject = readJson<unknown>(projectFile);
  if (!('project_inputs' in manifest)) problems.push(animaticTexts.main.projectInputsMissing);
  else if (!animaticProjectInputsMatch(manifest.project_inputs, currentProject)) problems.push(animaticTexts.main.projectInputsChanged);
  for (const [name, digest] of Object.entries(sources)) check(name, digest);
  for (const name of [manifest.source_audio ?? 'source/track.mp3']) {
    if (!(name in sources)) check(name, name === manifest.source_audio ? manifest.source_audio_sha256 : undefined);
  }
  const receipt = readJson<CardsReceipt>(join(project, 'plan/animatic/cards/manifest.json'));
  const registry = readJson<{ references?: Record<string, { path?: string }> }>(join(project, 'plan/scenes.json'));
  for (const shot of manifest.shots ?? []) {
    if (!shot.path) {
      problems.push(animaticTexts.main.shotInputMissing({ shot: shot.id }));
      continue;
    }
    if (!(shot.path in sources)) check(shot.path, shot.sha256);
    if (shot.path_last && !(shot.path_last in sources)) check(shot.path_last, shot.sha256_last);
    const assetPath = join(project, 'assets/shots', shot.id, 'manifest.json');
    const asset = readJson<{ shot?: string; accepted_edit?: { fps?: number; frames?: number; video?: { path?: string; sha256?: string } } }>(assetPath);
    if (shot.media === 'video') {
      const edit = asset?.accepted_edit;
      const selected = edit?.video?.path
        ? relative(project, resolve(dirname(assetPath), edit.video.path))
            .split(sep)
            .join('/')
        : null;
      if (
        asset?.shot !== shot.id ||
        selected !== shot.path ||
        edit?.video?.sha256 !== (sources[shot.path] ?? shot.sha256) ||
        edit?.fps !== FPS ||
        edit.frames !== shot.frames
      ) {
        problems.push(animaticTexts.main.acceptedEditChanged({ shot: shot.id }));
      }
      continue;
    }
    if (existsSync(assetPath)) {
      problems.push(animaticTexts.main.acceptedEditAdded({ shot: shot.id }));
      continue;
    }
    const selected = selectedFrames(project, shot.id);
    const entry = receipt?.cards?.[shot.id];
    // Старый manifest можно сверить по квитанции только пока её карточка совпадает с собранной.
    const receiptMatches =
      receipt?.registry_sha256 === manifest.scene_registry_sha256 &&
      entry?.sha256 === (sources[shot.path] ?? shot.sha256) &&
      (!shot.path_last || entry?.last?.sha256 === (sources[shot.path_last] ?? shot.sha256_last));
    const recorded = shot.keyframes ?? (receiptMatches ? entry?.keyframes : undefined) ?? null;
    const normalize = (frames: FrameSource[] | null): unknown =>
      frames?.map(({ id, role, time_seconds, path, sha256 }) => ({ id, role, time_seconds, path, sha256 })) ?? null;
    if (JSON.stringify(normalize(selected)) !== JSON.stringify(normalize(recorded))) problems.push(animaticTexts.main.keyframesChanged({ shot: shot.id }));
    if (shot.media === 'keyframes' && !recorded) problems.push(animaticTexts.main.keyframeSourcesMissing({ shot: shot.id }));
    for (const frame of recorded ?? []) if (!(frame.path in sources)) check(frame.path, frame.sha256);
    if (!recorded) {
      // «—» помечает план без референсов и источником карточки не является.
      const references = new Set([...(shot.references ?? shot.refs ?? []), shot.card?.primary_reference].filter((id): id is string => !!id && id !== '—'));
      for (const id of references) {
        const name = registry?.references?.[id]?.path;
        if (!name) problems.push(animaticTexts.main.referencePathMissing({ shot: shot.id, id }));
        else if (!(name in sources)) check(name, receiptMatches ? receipt?.reference_hashes?.[name] : undefined);
      }
    }
  }
  if (manifest.video_file) check(`plan/animatic/latest/${manifest.video_file}`, manifest.video_sha256);
  return [...new Set(problems)];
}
