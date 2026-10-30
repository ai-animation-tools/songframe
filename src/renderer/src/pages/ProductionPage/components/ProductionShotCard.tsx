import { productionTexts } from '@shared/texts/production';
/** Описание выбранного плана, повтор по сохранённому запросу и принятые видео. */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type { BrokenPackage, JobInfo, ShotProduction } from '@shared/types';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { formatClock } from '../../../format';
import { JobStatus } from '../../../components/JobStatus';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON, PYTHON_REASON } from '../constants';
import { DerivedShotNotice } from './DerivedShotNotice';
import { LinkedText } from '../../../components/LinkedText';
import { ShotPageButton } from '../../../components/ShotPageButton';

export function ProductionShotCard({
  shot,
  busy,
  operation,
  pythonAvailable,
  onRegenerate,
  selectedPackage,
  onOpenPackage,
  broken = [],
  onDiscardBroken
}: {
  shot: ShotProduction;
  busy: boolean;
  operation?: { job?: JobInfo; error?: string; running?: boolean; label?: string };
  pythonAvailable: boolean;
  onRegenerate(id: string): void;
  /** Текущий выбор пакета: вопросы уже открытого пакета повторно не предлагаются. */
  selectedPackage?: string;
  onOpenPackage?(dir: string): void;
  /** Повреждённые папки этого плана в очереди или batches: без workflow.json они блокируют «Сохранить в очередь». */
  broken?: BrokenPackage[];
  onDiscardBroken?(item: BrokenPackage): void;
}): ReactElement {
  const waiting = shot.packages.filter((pkg) => pkg.pendingDecision && pkg.dir !== selectedPackage);
  const sending = shot.packages.some((pkg) => ['submission_unknown', 'submitting'].includes(pkg.request?.attemptStatus ?? ''));
  // Несовместимость запроса устраняет пользователь, поэтому она важнее временной занятости.
  const regenerateReason =
    shot.regenerateProblem ?? (busy ? BUSY_REASON : !pythonAvailable ? PYTHON_REASON : sending ? productionTexts.productionShotCard.submissionUnknown : null);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h6">{shot.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          {productionTexts.productionShotCard.title({
            title: shot.title,
            start: formatClock(shot.start),
            end: formatClock(shot.end),
            seconds: (shot.end - shot.start).toFixed(2),
            lipsync: shot.lipsync
          })}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ mt: 1 }}>
        {shot.original}
      </Typography>
      {shot.derivedFrom ? (
        <Box sx={{ mt: 1.5 }}>
          <DerivedShotNotice source={shot.derivedFrom} />
        </Box>
      ) : null}
      {/* Статус задаёт главный процесс по отпечатку постановки; комплект остаётся доступен для просмотра. */}
      {shot.state === 'stale' ? (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          <LinkedText text={productionTexts.productionShotCard.stale} />
        </Alert>
      ) : null}
      {broken.map((item) => (
        <Alert
          key={item.dir}
          severity="error"
          sx={{ mt: 1.5 }}
          action={
            onDiscardBroken ? (
              <DestructiveButton
                label={productionTexts.productionShotCard.deleteFolder}
                description={productionTexts.productionShotCard.deleteFolderDescription({ relative: item.relative })}
                confirmLabel={productionTexts.productionShotCard.deleteFolder}
                startIcon={<DeleteForeverIcon />}
                disabled={busy}
                disabledReason={BUSY_REASON}
                onConfirm={() => onDiscardBroken(item)}
              />
            ) : undefined
          }
        >
          {productionTexts.productionShotCard.brokenHint({ relative: item.relative, reason: item.reason })}
        </Alert>
      ))}
      {waiting.map((pkg) => (
        <Alert
          key={pkg.dir}
          severity="info"
          sx={{ mt: 1.5 }}
          action={
            onOpenPackage ? (
              <Button size="small" color="inherit" startIcon={<FolderOpenIcon />} onClick={() => onOpenPackage(pkg.dir)}>
                {productionTexts.productionShotCard.openPackage}
              </Button>
            ) : undefined
          }
        >
          {productionTexts.productionShotCard.pending({ relative: pkg.relative, question: pkg.pendingDecision!.question })}
        </Alert>
      ))}
      {shot.asset ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="subtitle2" gutterBottom>
            {productionTexts.productionShotCard.accepted}
          </Typography>
          {!shot.asset.video ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {productionTexts.productionShotCard.missingVideo}
            </Alert>
          ) : null}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {shot.asset.video ? (
              <video controls preload="metadata" src={window.api.shell.fileUrl(shot.asset.video)} style={{ width: 360, borderRadius: 8, background: '#000' }} />
            ) : null}
            {shot.asset.original && shot.asset.original !== shot.asset.video ? (
              <video
                controls
                preload="metadata"
                src={window.api.shell.fileUrl(shot.asset.original)}
                style={{ width: 360, borderRadius: 8, background: '#000' }}
              />
            ) : null}
          </Box>
        </Box>
      ) : null}
      {/* Действия блока внизу слева, того же вида, что ряд подготовки плана; результат — сразу под ним, причина недоступности — в подсказке кнопки. */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mt: 2 }}>
        {shot.state === 'completed' || shot.packages.length ? (
          <ActionButton
            startIcon={<ReplayIcon />}
            title={productionTexts.productionShotCard.retryHint}
            disabled={busy || !pythonAvailable || !!shot.regenerateProblem || sending}
            disabledReason={regenerateReason}
            onClick={() => onRegenerate(shot.id)}
          >
            {productionTexts.productionShotCard.retry}
          </ActionButton>
        ) : null}
        {/* Постановку плана правят в реестре сцен; переход открывает её редактор у этого же плана. */}
        <ShotPageButton page="scenario" shot={shot.id} size="medium" />
      </Stack>
      <JobStatus {...operation} />
    </Paper>
  );
}
