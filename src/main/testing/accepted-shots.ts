/** Отмечает комплекты тестового проекта принятыми по текущей постановке, как это делает accept_shot. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenesFile } from '@shared/types';
import { projectFingerprints, writeAcceptedFingerprints } from '../shot-acceptance';

export function stampAcceptedShots(project: string, ids: string[]): void {
  const scenes = JSON.parse(readFileSync(join(project, 'plan', 'scenes.json'), 'utf-8')) as ScenesFile;
  const fingerprints = projectFingerprints(project, scenes);
  writeAcceptedFingerprints(project, Object.fromEntries(ids.map((id) => [id, fingerprints[id]])));
}
