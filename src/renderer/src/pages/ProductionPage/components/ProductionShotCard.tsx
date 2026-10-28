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
    shot.regenerateProblem ??
    (busy
      ? BUSY_REASON
      : !pythonAvailable
        ? PYTHON_REASON
        : sending
          ? 'Исход отправки попытки этого плана ещё не известен: сначала выясните его в карточке пакета.'
          : null);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h6">{shot.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          {shot.title} · {formatClock(shot.start)}–{formatClock(shot.end)} · {(shot.end - shot.start).toFixed(2)} с{shot.lipsync ? ' · липсинк' : ''}
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
      {broken.map((item) => (
        <Alert
          key={item.dir}
          severity="error"
          sx={{ mt: 1.5 }}
          action={
            onDiscardBroken ? (
              <DestructiveButton
                label="Удалить папку"
                description={`Папка ${item.relative} будет удалена безвозвратно вместе со всем содержимым. Принятый комплект сцены и исходники не затрагиваются.`}
                confirmLabel="Удалить папку"
                startIcon={<DeleteForeverIcon />}
                disabled={busy}
                disabledReason={BUSY_REASON}
                onConfirm={() => onDiscardBroken(item)}
              />
            ) : undefined
          }
        >
          Папка {item.relative}: {item.reason}. Пока она есть, «Сохранить в очередь» для этого плана не сработает.
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
                Открыть пакет
              </Button>
            ) : undefined
          }
        >
          Пакет {pkg.relative} ждёт вашего решения: {pkg.pendingDecision!.question}
        </Alert>
      ))}
      {shot.asset ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="subtitle2" gutterBottom>
            Принятые материалы
          </Typography>
          {!shot.asset.video ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Файл принятого монтажного видео отсутствует. Приёмка сохранена; восстановите файл перед сборкой с этим видео.
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
      {/* Действие блока внизу слева, того же вида, что ряд подготовки плана; результат — сразу под ним, причина недоступности — в подсказке кнопки. */}
      {shot.state === 'completed' || shot.packages.length ? (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
          <ActionButton
            startIcon={<ReplayIcon />}
            title="Создать новую попытку по сохранённому запросу без отправки и оплаты"
            disabled={busy || !pythonAvailable || !!shot.regenerateProblem || sending}
            disabledReason={regenerateReason}
            onClick={() => onRegenerate(shot.id)}
          >
            Подготовить повтор
          </ActionButton>
        </Stack>
      ) : null}
      <JobStatus {...operation} />
    </Paper>
  );
}
