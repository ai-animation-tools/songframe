/** Локальная подготовка производного плана отделена от запросов агентов и провайдеров. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DerivedShotPreview, DerivedShotRecipe, DerivedShotView } from '@shared/derived-shot';
import { checkedDerivedRecipe, derivedRecipeProblem } from '@shared/derived-shot';
import { derivedMainTexts as texts } from '@shared/texts/derived-shot-main';
import type { ScenesFile } from '@shared/types';
import { canonicalJson } from './scene-fingerprint';
import { shotAcceptance } from './shot-acceptance';
import { readSourceVideoSnapshot } from './derived-source';
import type { Jobs } from './jobs';
import { readLocalJson, writeLocalJson } from './local-files';
import { requireMediaBinaries } from './media-runtime';

const SHOT = /^M\d{2}(?:\.\d+)?$/;
const ID = /^[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;
interface Draft {
  schema_version: 1;
  shot: string;
  source_shot: string;
  recipe: DerivedShotRecipe;
}
interface Latest {
  id: string;
  jobId: string;
  operation: 'build' | 'accept';
}
interface Receipt {
  schema_version: 1;
  shot: string;
  source_shot: string;
  source_scene_sha256: string;
  source_accepted_video_sha256: string;
  target_scene_sha256: string;
  target_frames: number;
  recipe: DerivedShotRecipe;
  result_token: string;
  video: { path: string; sha256: string };
  preview: { path: string; sha256: string };
  audio_source: { path: string; sha256: string | null };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const read = <T>(path: string): T | null => {
  try {
    return readLocalJson<T>(path);
  } catch {
    return null;
  }
};
const hashes = new Map<string, { identity: string; sha: string }>();
function digest(path: string): string {
  const info = statSync(path, { bigint: true });
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  let entry = hashes.get(path);
  if (entry?.identity !== identity) {
    entry = { identity, sha: createHash('sha256').update(readFileSync(path)).digest('hex') };
    if (hashes.size >= 128) hashes.clear();
    hashes.set(path, entry);
  }
  return entry.sha;
}
function artifact(directory: string, value: unknown): string {
  if (!record(value) || typeof value.path !== 'string' || !value.path || isAbsolute(value.path) || typeof value.sha256 !== 'string' || !SHA.test(value.sha256))
    throw new Error(texts.previewInvalid);
  const path = realpathSync(resolve(directory, value.path));
  const local = relative(directory, path);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !statSync(path).isFile() || digest(path) !== value.sha256)
    throw new Error(texts.previewInvalid);
  return path;
}

/** Даже без трека снимок хранит его объявленный путь: появление файла меняет услышанную пользователем пробу. */
function audioSource(project: string, value: unknown): Receipt['audio_source'] | null {
  if (typeof value !== 'string' || !value.startsWith('source/') || value.includes('\\') || value.split('/').includes('..')) return null;
  try {
    const path = resolve(project, value);
    let existing = path;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    const canonical = realpathSync(existing);
    const local = relative(project, canonical);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
    return { path: value, sha256: existing === path && statSync(path).isFile() ? digest(path) : null };
  } catch {
    return null;
  }
}

/** Принятие принадлежит проекту: журнал задания может исчезнуть после очистки истории или переноса. */
function acceptedResult(project: string, shot: string, receipt: Receipt): boolean {
  try {
    const directory = realpathSync(join(project, 'assets/shots', shot));
    const manifestPath = join(directory, 'manifest.json');
    const manifest = read<Record<string, unknown>>(manifestPath);
    if (manifest?.schema_version !== 1 || manifest.shot !== shot || manifest.kind !== 'derived_video' || !record(manifest.accepted_edit)) return false;
    const video = manifest.accepted_edit.video;
    if (!record(video) || (video.root !== undefined && video.root !== 'asset') || video.sha256 !== receipt.video.sha256) return false;
    artifact(directory, video);
    const manifestSha = digest(manifestPath);
    const history = join(project, 'plan/derived-history');
    return readdirSync(history, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() || !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(entry.name)) return false;
      const journal = read<Record<string, unknown>>(join(history, entry.name, 'journal.json'));
      const kit = journal && record(journal.directory) ? journal.directory : null;
      return (
        journal?.schema_version === 1 &&
        journal.id === entry.name &&
        journal.shot === shot &&
        journal.state === 'committed' &&
        journal.result_token === receipt.result_token &&
        kit?.path === `assets/shots/${shot}` &&
        record(kit.after_files) &&
        kit.after_files['manifest.json'] === manifestSha
      );
    });
  } catch {
    // Старый committed-журнал не означает принятия после удаления или замены выбранного комплекта.
    return false;
  }
}

export class DerivedWorkflow {
  constructor(private readonly jobs: Jobs) {}

  private project(project: string, shot: string): string {
    if (typeof project !== 'string' || !isAbsolute(project) || !SHOT.test(shot)) throw new Error(texts.projectInvalid);
    const canonical = realpathSync(project);
    if (!existsSync(join(canonical, 'plan/project.json'))) throw new Error(texts.projectInvalid);
    return canonical;
  }
  private directory(project: string, shot: string): string {
    return join(project, 'plan/derived', shot);
  }
  private latest(project: string, shot: string): Latest | null {
    const value = read<Latest>(join(this.directory(project, shot), 'latest.json'));
    return value && typeof value.id === 'string' && ID.test(value.id) && typeof value.jobId === 'string' && ['build', 'accept'].includes(value.operation)
      ? value
      : null;
  }
  private active(project: string) {
    return this.jobs.list().find((job) => job.status === 'running' && job.project === project && job.steps.some((step) => step.tool === 'derive_shot')) ?? null;
  }

  view(project: string, shot: string): DerivedShotView {
    const canonical = this.project(project, shot);
    const registry = read<ScenesFile>(join(canonical, 'plan/scenes.json'));
    const target = registry?.scenes?.find((scene) => scene.id === shot);
    if (!registry || !target) throw new Error(texts.sceneMissing);
    const sourceShot = target.derived_from?.shot ?? null;
    const source = registry.scenes.find((scene) => scene.id === sourceShot);
    const targetFrames = target.end_frame_exclusive - target.start_frame;
    const acceptance = shotAcceptance(canonical, registry);
    const snapshot = sourceShot && SHOT.test(sourceShot) ? readSourceVideoSnapshot(canonical, sourceShot) : null;
    const sourceManifest =
      sourceShot && SHOT.test(sourceShot) ? read<Record<string, unknown>>(join(canonical, 'assets/shots', sourceShot, 'manifest.json')) : null;
    const edit = sourceManifest && record(sourceManifest.accepted_edit) ? sourceManifest.accepted_edit : null;
    const sourceFrames = typeof edit?.frames === 'number' && edit.fps === 30 && Number.isSafeInteger(edit.frames) ? edit.frames : 0;
    const problem = !sourceShot
      ? texts.notDerived
      : !source || sourceShot === shot || source.derived_from
        ? texts.invalidSource
        : target.lipsync
          ? texts.lipsyncUnsupported
          : !snapshot || !sourceFrames || !acceptance.accepted.has(sourceShot)
            ? texts.sourceUnavailable
            : acceptance.accepted.get(sourceShot) !== 'completed'
              ? texts.sourceStale
              : null;
    let toolsProblem: string | null = null;
    try {
      this.jobs.launcher.runtime();
      requireMediaBinaries(this.jobs.launcher.options);
    } catch {
      toolsProblem = texts.toolsUnavailable;
    }
    const draft = read<Draft>(join(this.directory(canonical, shot), 'draft.json'));
    let recipe: DerivedShotRecipe | null = null;
    if (draft?.schema_version === 1 && draft.shot === shot) {
      try {
        recipe = checkedDerivedRecipe(draft.recipe);
      } catch {
        /* Повреждённые настройки можно заменить явным сохранением формы. */
      }
    }
    const latest = this.latest(canonical, shot);
    const job = this.active(canonical) ?? (latest ? this.jobs.get(latest.jobId) : null);
    let preview: DerivedShotPreview | null = null;
    if (latest) {
      const directory = join(this.directory(canonical, shot), latest.id);
      const receipt = read<Receipt>(join(directory, 'preview.json'));
      const build = read<{ source_manifest_sha256?: unknown }>(join(directory, 'build.json'));
      if (receipt?.schema_version === 1 && receipt.shot === shot && typeof receipt.result_token === 'string' && SHA.test(receipt.result_token)) {
        try {
          const videoPath = artifact(directory, receipt.preview);
          const candidatePath = artifact(directory, receipt.video);
          const savedRecipe = checkedDerivedRecipe(receipt.recipe);
          const audio = audioSource(canonical, registry.audio?.path);
          const fresh =
            !problem &&
            receipt.source_shot === sourceShot &&
            receipt.target_frames === targetFrames &&
            receipt.target_scene_sha256 === acceptance.fingerprints?.[shot] &&
            receipt.source_scene_sha256 === acceptance.fingerprints?.[sourceShot!] &&
            receipt.source_accepted_video_sha256 === snapshot?.acceptedVideoSha256 &&
            // Python переносит происхождение из всего манифеста: правка его метаданных тоже требует новой пробы.
            typeof build?.source_manifest_sha256 === 'string' &&
            SHA.test(build.source_manifest_sha256) &&
            build.source_manifest_sha256 === digest(join(canonical, 'assets/shots', sourceShot!, 'manifest.json')) &&
            audio !== null &&
            record(receipt.audio_source) &&
            receipt.audio_source.path === audio.path &&
            receipt.audio_source.sha256 === audio.sha256 &&
            canonicalJson(recipe) === canonicalJson(savedRecipe);
          preview = {
            id: latest.id,
            videoPath,
            candidatePath,
            resultToken: receipt.result_token,
            recipe: savedRecipe,
            frames: receipt.target_frames,
            fresh,
            problem: fresh ? null : texts.previewStale,
            accepted: acceptedResult(canonical, shot, receipt)
          };
        } catch {
          // Показанный ранее файл не заменяется другим: пользователю требуется явная новая сборка.
          preview = null;
        }
      }
    }
    return {
      project: canonical,
      shot,
      title: target.title ?? registry.sequences.find((sequence) => sequence.id === target.sequence)?.title ?? shot,
      action: target.action ?? '',
      sourceShot,
      sourceTitle: source?.title ?? registry.sequences.find((sequence) => sequence.id === source?.sequence)?.title ?? sourceShot ?? '',
      sourcePath: snapshot?.videoPath ?? null,
      sourceFrames,
      targetFrames,
      recipe,
      preview,
      job,
      problem,
      toolsProblem,
      hasAsset: existsSync(join(canonical, 'assets/shots', shot, 'manifest.json'))
    };
  }

  save(project: string, shot: string, value: unknown): DerivedShotView {
    const view = this.view(project, shot);
    if (!view.sourceShot) throw new Error(texts.notDerived);
    if (this.active(view.project)) throw new Error(texts.busy);
    const recipe = checkedDerivedRecipe(value);
    writeLocalJson(join(this.directory(view.project, shot), 'draft.json'), { schema_version: 1, shot, source_shot: view.sourceShot, recipe });
    return this.view(view.project, shot);
  }

  build(project: string, shot: string, value: unknown): DerivedShotView {
    const view = this.view(project, shot);
    if (this.active(view.project)) throw new Error(texts.busy);
    if (view.problem || view.toolsProblem) throw new Error(view.problem ?? view.toolsProblem!);
    const recipe = checkedDerivedRecipe(value);
    const problem = derivedRecipeProblem(recipe, view.targetFrames, view.sourceFrames);
    if (problem) throw new Error(problem);
    this.save(view.project, shot, recipe);
    const id = randomUUID();
    const base = `plan/derived/${shot}`;
    const recipePath = `${base}/recipes/${id}.json`;
    writeLocalJson(join(view.project, recipePath), recipe);
    const job = this.jobs.start('tool', texts.buildTitle({ shot }), view.project, [
      { tool: 'derive_shot', args: ['build', '--shot', shot, '--recipe', recipePath, '--work-dir', `${base}/${id}`, '--json'], label: texts.buildStep }
    ]);
    writeLocalJson(join(this.directory(view.project, shot), 'latest.json'), { id, jobId: job.id, operation: 'build' });
    return this.view(view.project, shot);
  }

  accept(project: string, shot: string, id: string, token: string, replace: boolean): DerivedShotView {
    const view = this.view(project, shot);
    if (this.active(view.project)) throw new Error(texts.busy);
    if (view.problem || view.toolsProblem) throw new Error(view.problem ?? view.toolsProblem!);
    if (!view.preview || view.preview.id !== id || view.preview.resultToken !== token) throw new Error(texts.previewMissing);
    if (!view.preview.fresh) throw new Error(texts.previewStale);
    if (view.hasAsset && replace !== true && !view.preview.accepted) throw new Error(texts.replacementRequired);
    const job = this.jobs.start('tool', texts.acceptTitle({ shot }), view.project, [
      {
        tool: 'derive_shot',
        args: ['accept', '--work-dir', `plan/derived/${shot}/${id}`, '--confirm', token, ...(replace === true ? ['--replace'] : []), '--json'],
        label: texts.acceptStep
      }
    ]);
    writeLocalJson(join(this.directory(view.project, shot), 'latest.json'), { id, jobId: job.id, operation: 'accept' });
    return this.view(view.project, shot);
  }
}
