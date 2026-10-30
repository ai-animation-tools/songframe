/** Снимок выбранного клипа источника: свежесть не зависит от посторонних полей его манифеста. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hashes = new Map<string, { identity: string; sha256: string }>();

export interface SourceVideoSnapshot {
  acceptedVideoSha256: string;
  videoPath: string;
}

/** Проверяет фактический выбранный файл, повторно читая большие клипы только после изменения stat. */
export function readSourceVideoSnapshot(project: string, sourceShot: string): SourceVideoSnapshot | null {
  try {
    const directory = realpathSync(join(project, 'assets', 'shots', sourceShot));
    const manifest: unknown = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (
      !record(manifest) ||
      manifest.schema_version !== 1 ||
      manifest.shot !== sourceShot ||
      manifest.kind === 'derived_video' ||
      !record(manifest.accepted_edit)
    )
      return null;
    const video = manifest.accepted_edit.video;
    if (
      !record(video) ||
      typeof video.path !== 'string' ||
      !video.path ||
      isAbsolute(video.path) ||
      (video.root !== undefined && video.root !== 'asset') ||
      typeof video.sha256 !== 'string' ||
      !SHA256.test(video.sha256)
    )
      return null;
    const videoPath = realpathSync(resolve(directory, video.path));
    const local = relative(directory, videoPath);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return null;
    const info = statSync(videoPath, { bigint: true });
    if (!info.isFile()) return null;
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    let cached = hashes.get(videoPath);
    if (cached?.identity !== identity) {
      cached = { identity, sha256: createHash('sha256').update(readFileSync(videoPath)).digest('hex') };
      if (hashes.size >= 512) hashes.clear();
      hashes.set(videoPath, cached);
    }
    return cached.sha256 === video.sha256 ? { acceptedVideoSha256: cached.sha256, videoPath } : null;
  } catch {
    return null;
  }
}
