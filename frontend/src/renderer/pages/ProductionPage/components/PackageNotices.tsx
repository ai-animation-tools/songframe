import { productionTexts } from '@shared/texts/production';
/** Что мешает всему пути попытки: возврат с замечанием, очередь, смена постановки и проблемы материалов. */
import type { ReactElement } from 'react';
import { Alert, Box, Chip } from '@mui/material';
import { SCENE_CHANGED } from '@shared/production-labels';
import type { PackageView } from '@shared/types';
import { LinkedText } from '../../../components/LinkedText';
import { BUSY_REASON, VERDICT_LABELS } from '../constants';
import { isQueuedPackage } from '../decisions';
import { PackageRevisionNotice } from './PackageRevisionNotice';
import { PackageSceneChanged } from './PackageSceneChanged';

export function PackageNotices({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  onKeepForScene,
  onOpenRevision
}: {
  pkg: PackageView;
  busy: boolean;
  busyReason?: string;
  onKeepForScene(): void;
  onOpenRevision(focusNote?: boolean): void;
}): ReactElement {
  // Проблема устаревшей постановки показывается отдельным блоком с выбором действия.
  const problems = pkg.problems.filter((problem) => !(pkg.sceneChanged && problem === SCENE_CHANGED));
  const returned = !pkg.pendingDecision && pkg.decision?.verdict === 'revise';
  const lastAnswer = pkg.decision && !returned ? (VERDICT_LABELS[pkg.decision.verdict ?? '']?.label ?? pkg.decision.verdict) : null;
  return (
    <>
      {pkg.retryOf || pkg.waitReason || lastAnswer ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {pkg.retryOf ? <Chip size="small" variant="outlined" label={productionTexts.packageCard.retry({ attempt: pkg.retryOf.split('/').pop() })} /> : null}
          {pkg.waitReason ? <Chip size="small" variant="outlined" color="warning" label={pkg.waitReason} /> : null}
          {lastAnswer ? (
            <Chip size="small" variant="outlined" label={productionTexts.packageCard.lastAnswer({ label: lastAnswer, note: pkg.decision?.note })} />
          ) : null}
        </Box>
      ) : null}
      <PackageRevisionNotice pkg={pkg} onOpenRevision={onOpenRevision} />
      {isQueuedPackage(pkg) ? <Alert severity="info">{productionTexts.packageCard.queued}</Alert> : null}
      {pkg.sceneChanged ? (
        <PackageSceneChanged pkg={pkg} busy={busy} busyReason={busyReason} onKeep={onKeepForScene} onOpenRevision={() => onOpenRevision(true)} />
      ) : null}
      {problems.length ? (
        <Alert severity="warning">
          <LinkedText text={problems.join(' ')} />
        </Alert>
      ) : null}
    </>
  );
}
