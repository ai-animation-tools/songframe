/** Декоративная обложка и время сохранения не являются входами сценария или производства. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

export function sourceInputDigestFromBytes(bytes: string | Buffer): string {
  try {
    const value: unknown = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) return digest(bytes);
    const inputs = { ...value } as Record<string, unknown>;
    delete inputs.cover;
    delete inputs.updated_at;
    return digest(JSON.stringify(canonical(inputs)));
  } catch {
    // Повреждённый JSON не маскируется под прежний корректный набор входов.
    return digest(bytes);
  }
}

export function sourceInputDigest(project: string): string | null {
  const path = join(project, 'source/manifest.json');
  return existsSync(path) ? sourceInputDigestFromBytes(readFileSync(path)) : null;
}

/** Старый снимок переводим только при точном совпадении прежних байтов, не утверждая неизвестные изменения. */
export function upgradeSourceInputSnapshot(hashes: Record<string, string | null>, project: string): boolean {
  const path = join(project, 'source/manifest.json');
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  if (hashes['source/manifest.json'] !== digest(bytes)) return false;
  const next = sourceInputDigestFromBytes(bytes);
  if (hashes['source/manifest.json'] === next) return false;
  hashes['source/manifest.json'] = next;
  return true;
}
