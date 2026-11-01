/** Описание связанного объекта принадлежит source; appearance в cast хранит только его проекцию. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CastFile, SourceManifest } from '@shared/types';
import { sourcesTexts } from '@shared/texts/sources';
import { referenceImageTexts } from '@shared/texts/reference-images';
import { readManifest } from './sources';
import { writeAtomicBytes } from './local-files';

export function descriptionManifest(project: string): SourceManifest | null {
  const path = join(project, 'source/manifest.json');
  if (!existsSync(path)) return null;
  const manifest = readManifest(project);
  if (
    !manifest ||
    !Array.isArray(manifest.references) ||
    manifest.references.some((ref) => !ref || typeof ref.id !== 'string' || (ref.description !== undefined && typeof ref.description !== 'string'))
  )
    throw new Error(sourcesTexts.main.manifestInvalid);
  return manifest;
}

/** Чтение не пишет файлы: отсутствие ref оставляет собственное описание сущности, в том числе world. */
export function projectCastDescriptions(cast: CastFile, manifest: SourceManifest | null): CastFile {
  if (!Array.isArray(cast?.entities) || !manifest) return structuredClone(cast);
  const descriptions = new Map(manifest.references.map((ref) => [ref.id, ref.description ?? '']));
  return {
    ...structuredClone(cast),
    entities: cast.entities.map((entity) =>
      descriptions.has(entity.id) ? { ...structuredClone(entity), appearance: descriptions.get(entity.id)! } : structuredClone(entity)
    )
  };
}
export function castDescriptionDrifts(cast: CastFile, manifest: SourceManifest | null): string[] {
  if (!Array.isArray(cast?.entities) || !manifest) return [];
  const current = projectCastDescriptions(cast, manifest);
  return cast.entities.filter((entity, index) => entity.appearance !== current.entities[index].appearance).map((entity) => entity.id);
}

/** Только явная запись из кастинга меняет canonical description; сохранение исходников проецирует обратное направление. */
export function planCastDescriptions(cast: CastFile, manifest: SourceManifest | null, owner: 'source' | 'cast' = 'source') {
  const nextManifest = manifest ? structuredClone(manifest) : null;
  if (nextManifest && owner === 'cast') {
    const entities = new Map(cast.entities.map((entity) => [entity.id, entity]));
    let changed = false;
    for (const ref of nextManifest.references) {
      const entity = entities.get(ref.id);
      if (entity && ref.description !== entity.appearance) {
        ref.description = entity.appearance;
        changed = true;
      }
    }
    if (changed) nextManifest.updated_at = new Date().toISOString();
  }
  return { manifest: nextManifest, cast: projectCastDescriptions(cast, nextManifest) };
}

/** Узкая публикация двух JSON: сбой восстанавливает прежние байты, а при сбое отката оставляет резерв. */
export function publishCastDescriptionPlan(project: string, plan: ReturnType<typeof planCastDescriptions>): void {
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const values = new Map<string, Buffer>([['plan/cast.json', json(plan.cast)]]);
  if (plan.manifest) {
    const current = descriptionManifest(project);
    if (JSON.stringify(current) !== JSON.stringify(plan.manifest)) values.set('source/manifest.json', json(plan.manifest));
  }
  const changes = [...values]
    .map(([name, next]) => ({
      name,
      next,
      before: existsSync(join(project, name)) ? readFileSync(join(project, name)) : null
    }))
    .filter(({ before, next }) => !before?.equals(next));
  if (!changes.length) return;
  const backup = mkdtempSync(join(tmpdir(), 'songframe-description-save-'));
  let keep = false;
  try {
    for (const [index, change] of changes.entries()) if (change.before) writeFileSync(join(backup, `${index}.json`), change.before);
    try {
      // Canonical описание публикуется до проекции; чтение всегда берёт его даже при прерывании процесса.
      for (const change of [...changes].reverse()) {
        writeAtomicBytes(join(project, change.name), change.next);
      }
    } catch (error) {
      try {
        for (const change of changes) {
          if (change.before === null) rmSync(join(project, change.name), { force: true });
          else writeAtomicBytes(join(project, change.name), change.before);
        }
      } catch (restoreError) {
        keep = true;
        throw new Error(referenceImageTexts.restoreFailed({ path: backup, reason: String(restoreError) }), { cause: restoreError });
      }
      throw error;
    }
  } finally {
    if (!keep) rmSync(backup, { recursive: true, force: true });
  }
}
