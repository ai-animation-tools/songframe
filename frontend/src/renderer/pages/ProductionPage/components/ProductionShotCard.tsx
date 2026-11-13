import { productionTexts } from '@shared/texts/production';
/** Шапка выбранного плана: что за план, какая попытка и что сейчас; редкие действия — в меню. */
import { useState, type ReactElement } from 'react';
import { Alert, Box, Button, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ReplayIcon from '@mui/icons-material/Replay';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import MusicVideoIcon from '@mui/icons-material/MusicVideo';
import VideoFileOutlinedIcon from '@mui/icons-material/VideoFileOutlined';
import type { BrokenPackage, JobInfo, PackageView, ShotProduction } from '@shared/types';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { formatClock } from '../../../format';
import { JobStatus } from '../../../components/JobStatus';
import { BUSY_REASON } from '../constants';
import { isQueuedPackage } from '../decisions';
import { attemptLabel, REQUEST_IN_FLIGHT, type PlanTone } from '../planPath';
import { AcceptedAsset } from './AcceptedAsset';
import { DerivedShotNotice } from './DerivedShotNotice';
import { ShotSpendSummary } from './ShotSpendSummary';
import { LinkedText } from '../../../components/LinkedText';
import { ShotPageButton } from '../../../components/ShotPageButton';

const NOW_COLORS: Record<PlanTone, string> = { action: 'primary.main', wait: 'warning.main', done: 'success.main' };

export function ProductionShotCard({
  shot,
  busy,
  operation,
  onRegenerate,
  selectedPackage,
  onOpenPackage,
  broken = [],
  onDiscardBroken,
  now,
  onNewAttempt,
  onOwnVideo,
  onDiscardAttempt,
  onFragment,
  project,
  onSpendChanged
}: {
  shot: ShotProduction;
  busy: boolean;
  operation?: { job?: JobInfo; error?: string; running?: boolean; label?: string };
  onRegenerate(id: string): void;
  /** Текущий выбор пакета: вопросы уже открытого пакета повторно не предлагаются. */
  selectedPackage?: string;
  onOpenPackage?(dir: string): void;
  /** Повреждённые папки этого плана в очереди или batches: без workflow.json они блокируют «Сохранить в очередь». */
  broken?: BrokenPackage[];
  onDiscardBroken?(item: BrokenPackage): void;
  /** Фраза пути плана: что происходит и чей ход. */
  now?: { text: string; tone: PlanTone } | null;
  onNewAttempt?(): void;
  /** Загрузить своё видео плана новой попыткой без описания, опор и промпта. */
  onOwnVideo?(): void;
  /** Удалить попытку целиком; доступно вне незавершённой отправки. */
  onDiscardAttempt?(pkg: PackageView): void;
  /** Открыть фрагмент под музыку, начиная с этого плана. */
  onFragment?(): void;
  /** Проект плана: с ним карточка показывает расход плана и окно «Расход». */
  project?: string;
  /** Стоимость изменена в окне «Расход»: странице нужно перечитать бейджи. */
  onSpendChanged?(): void;
}): ReactElement {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const attempts = shot.derivedFrom ? [] : shot.packages;
  const attempt = attempts.find((pkg) => pkg.dir === selectedPackage) ?? null;
  const canDiscard = !!onDiscardAttempt && !!attempt && attempt.stage !== 'accepted' && !REQUEST_IN_FLIGHT.includes(attempt.request?.attemptStatus ?? '');
  const paidAttempt = !!attempt?.request?.generationId || (attempt?.request?.creditsConsumed ?? null) !== null;
  const canRetry = !shot.derivedFrom && (shot.state === 'completed' || shot.packages.length > 0);
  const waiting = (shot.derivedFrom ? [] : shot.packages).filter((pkg) => pkg.pendingDecision && pkg.dir !== selectedPackage);
  const sending = shot.packages.some((pkg) => ['submission_unknown', 'submitting'].includes(pkg.request?.attemptStatus ?? ''));
  // Несовместимость запроса устраняет пользователь, поэтому она важнее временной занятости.
  const regenerateReason = shot.regenerateProblem ?? (busy ? BUSY_REASON : sending ? productionTexts.productionShotCard.submissionUnknown : null);
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
        <Box sx={{ flex: 1 }} />
        {/* Постановку плана правят в реестре сцен; переход открывает её редактор у этого же плана. */}
        <ShotPageButton page="scenario" shot={shot.id} size="small" />
        {/* Просмотр плана с соседями под песню: без генерации, поэтому кнопка всегда доступна. */}
        {onFragment ? (
          <Button size="small" variant="outlined" startIcon={<MusicVideoIcon />} title={productionTexts.fragmentPreview.openHint} onClick={onFragment}>
            {productionTexts.fragmentPreview.open}
          </Button>
        ) : null}
        {canRetry || onNewAttempt || onOwnVideo || canDiscard ? (
          <Tooltip title={productionTexts.planPath.moreActions}>
            <IconButton size="small" aria-label={productionTexts.planPath.moreActions} onClick={(event) => setMenu(event.currentTarget)}>
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        {onNewAttempt ? (
          <MenuItem
            onClick={() => {
              setMenu(null);
              onNewAttempt();
            }}
          >
            <ListItemIcon>
              <AddIcon fontSize="small" />
            </ListItemIcon>
            {productionTexts.planPath.newAttempt}
          </MenuItem>
        ) : null}
        {onOwnVideo ? (
          <MenuItem
            disabled={busy}
            title={productionTexts.ownVideo.openHint}
            onClick={() => {
              setMenu(null);
              onOwnVideo();
            }}
          >
            <ListItemIcon>
              <VideoFileOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={productionTexts.planPath.ownVideo} secondary={busy ? BUSY_REASON : null} />
          </MenuItem>
        ) : null}
        {canRetry ? (
          <MenuItem
            disabled={!!regenerateReason}
            title={productionTexts.productionShotCard.retryHint}
            onClick={() => {
              setMenu(null);
              onRegenerate(shot.id);
            }}
          >
            <ListItemIcon>
              <ReplayIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary={productionTexts.planPath.retryFromRequest}
              secondary={regenerateReason}
              slotProps={{ secondary: { sx: { whiteSpace: 'normal', maxWidth: 320 } } }}
            />
          </MenuItem>
        ) : null}
        {canDiscard ? (
          <MenuItem
            disabled={busy}
            sx={{ color: 'error.main' }}
            onClick={() => {
              setMenu(null);
              setConfirmDiscard(true);
            }}
          >
            <ListItemIcon sx={{ color: 'inherit' }}>
              <DeleteForeverIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={productionTexts.planPath.deleteAttempt} secondary={busy ? BUSY_REASON : null} />
          </MenuItem>
        ) : null}
      </Menu>
      {attempt ? (
        <ConfirmationDialog
          open={confirmDiscard}
          title={productionTexts.packageCard.discard}
          confirmLabel={productionTexts.packageCard.delete}
          confirmIcon={<DeleteForeverIcon />}
          confirmColor="error"
          onClose={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onDiscardAttempt?.(attempt);
          }}
        >
          <Typography variant="body2">{productionTexts.packageCard.discardFolder({ relative: attempt.relative, paid: paidAttempt })}</Typography>
        </ConfirmationDialog>
      ) : null}
      {attempts.length || now ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mt: 1.5 }}>
          {attempts.length ? (
            <TextField
              select
              size="small"
              label={productionTexts.productionPage.packageLabel}
              value={selectedPackage ?? ''}
              onChange={(event) => onOpenPackage?.(event.target.value)}
              sx={{ minWidth: 240, maxWidth: '100%' }}
            >
              {selectedPackage === '__new__' ? <MenuItem value="__new__">{productionTexts.productionPage.newPreparation}</MenuItem> : null}
              {attempts.map((pkg) => (
                <MenuItem key={pkg.dir} value={pkg.dir}>
                  {productionTexts.productionPage.queuedPrefix({ queued: isQueuedPackage(pkg), relative: attemptLabel(pkg), stage: pkg.stageLabel })}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          {now ? (
            <Typography variant="body2" fontWeight={500} color={NOW_COLORS[now.tone]} role="status">
              {now.text}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
        {shot.original}
      </Typography>
      {project && !shot.derivedFrom ? <ShotSpendSummary project={project} shot={shot} onChanged={() => onSpendChanged?.()} /> : null}
      {shot.derivedFrom ? (
        <Box sx={{ mt: 1.5 }}>
          <DerivedShotNotice source={shot.derivedFrom} />
        </Box>
      ) : null}
      {/* Статус задаёт Go по отпечатку постановки; комплект остаётся доступен для просмотра. */}
      {shot.state === 'stale' ? (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          <LinkedText text={shot.staleReason ?? productionTexts.productionShotCard.stale} />
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
      {/* У производного плана нет пути: принятый результат показывается здесь, у обычного — в шаге «Результат». */}
      {shot.derivedFrom && shot.asset ? (
        <Box sx={{ mt: 1.5 }}>
          <AcceptedAsset asset={shot.asset} />
        </Box>
      ) : null}
      <JobStatus {...operation} />
    </Paper>
  );
}
