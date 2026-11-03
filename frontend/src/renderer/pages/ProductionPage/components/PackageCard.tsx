import { productionTexts } from '@shared/texts/production';
/** Пакет производства объединяет вопрос, материалы запроса и полученный результат. */
import type { ReactElement } from 'react';
import { Alert, Box, Chip, Paper, Typography } from '@mui/material';
import type { JobInfo, KeyframeNoteScope, PackageView } from '@shared/types';
import { normalizeMediaProvider } from '@shared/media-providers';
import { JobStatus } from '../../../components/JobStatus';
import { DestructiveButton } from '../../../components/DestructiveButton';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { BUSY_REASON, VERDICT_LABELS } from '../constants';
import { isQueuedPackage } from '../decisions';
import { PackageDecision } from './PackageDecision';
import { PackageRevisionNotice } from './PackageRevisionNotice';
import { PackageSceneChanged } from './PackageSceneChanged';
import { SCENE_CHANGED } from '@shared/production-labels';
import { PackageKeyframes } from './PackageKeyframes';
import { PackageRequest } from './PackageRequest';
import { PackageResume } from './PackageResume';
import { PackageResult } from './PackageResult';
import { PackageTextSection } from './PackageTextSection';
import { LinkedText } from '../../../components/LinkedText';

export function PackageCard({
  pkg,
  note,
  setNote,
  busy,
  busyReason = BUSY_REASON,
  operation,
  providers,
  onDecide,
  onSubmit,
  onAccept,
  onContactSheet,
  onReopenQuestion,
  onDiscard,
  onResume,
  onAttachResult,
  onNotCreated,
  onSelectImage,
  onReopenFrame,
  onKeepForScene,
  onSetKeyframeNote,
  onOpenRevision
}: {
  pkg: PackageView;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  /** Почему busy блокирует действия: идёт операция или нет Python. */
  busyReason?: string;
  operation?: { job?: JobInfo; error?: string; running?: boolean; label?: string };
  /** Найдена ли программа каждого платного провайдера (по id). */
  providers: Record<string, boolean>;
  onDecide(verdict: string, noteScope?: KeyframeNoteScope): void;
  onSubmit(): void;
  onAccept(): void;
  onContactSheet(): void;
  onReopenQuestion?(): void;
  /** Удалить попытку целиком; доступно пакету приложения вне незавершённой отправки. */
  onDiscard?(): void;
  onResume(): void;
  onAttachResult(files: string[]): void;
  onNotCreated(): void;
  onSelectImage(index: number): void;
  /** Вернуть утверждённую опору на доработку с замечанием. */
  onReopenFrame(frame: string, note: string, scope: KeyframeNoteScope): void;
  /** Оставить неотправленный пакет в силе для текущей постановки плана. */
  onKeepForScene(): void;
  /** Снять или вернуть замечание к опорам. */
  onSetKeyframeNote(id: number, active: boolean): void;
  /** focusNote=false — только прокрутить к блоку подготовки, не фокусируя поле доработки агентом. */
  onOpenRevision?(focusNote?: boolean): void;
}): ReactElement {
  // Проблема устаревшей постановки показывается отдельным блоком с выбором действия.
  const otherProblems = pkg.problems.filter((problem) => !(pkg.sceneChanged && problem === SCENE_CHANGED));
  const pending = pkg.pendingDecision;
  // Отправка и получение доступны, только если найдена программа провайдера сохранённого запроса.
  const providerAvailable = providers[normalizeMediaProvider(pkg.request?.provider) ?? ''] === true;
  const returnedForRevision = !pending && pkg.decision?.verdict === 'revise';
  const inFlight = [
    'submitting',
    'submission_unknown',
    'submitted',
    'running',
    'watermark_free_pending',
    'outputs_pending',
    'download_pending',
    'downloading',
    'polling'
  ].includes(pkg.request?.attemptStatus ?? '');
  const canDiscard = !!onDiscard && pkg.stage !== 'accepted' && !inFlight;
  const paidAttempt = !!pkg.request?.generationId || pkg.request?.creditsConsumed !== null;
  return (
    <Paper variant="outlined" sx={{ p: 2, borderColor: pending ? 'primary.main' : undefined }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        <Typography fontWeight={600}>{pkg.relative}</Typography>
        <Chip size="small" label={pkg.stageLabel} color={pending ? 'primary' : 'default'} variant="outlined" />
        {pkg.retryOf ? <Chip size="small" variant="outlined" label={productionTexts.packageCard.retry({ attempt: pkg.retryOf.split('/').pop() })} /> : null}
        {pkg.waitReason ? <Chip size="small" variant="outlined" color="warning" label={pkg.waitReason} /> : null}
        <Box sx={{ flex: 1 }} />
        {pkg.decision && !returnedForRevision ? (
          <Typography variant="caption" color="text.secondary">
            {productionTexts.packageCard.lastAnswer({
              label: VERDICT_LABELS[pkg.decision.verdict ?? '']?.label ?? pkg.decision.verdict,
              note: pkg.decision.note
            })}
          </Typography>
        ) : null}
      </Box>
      <PackageRevisionNotice pkg={pkg} onOpenRevision={onOpenRevision} />
      {isQueuedPackage(pkg) ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {productionTexts.packageCard.queued}
        </Alert>
      ) : null}
      {pkg.sceneChanged ? (
        <PackageSceneChanged pkg={pkg} busy={busy} busyReason={busyReason} onKeep={onKeepForScene} onOpenRevision={() => onOpenRevision?.(true)} />
      ) : null}
      {otherProblems.length ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <LinkedText text={otherProblems.join(' ')} />
        </Alert>
      ) : null}

      {pkg.description ? <PackageTextSection title={productionTexts.packageCard.description} text={pkg.description} maxHeight={260} /> : null}

      <PackageKeyframes pkg={pkg} busy={busy} busyReason={busyReason} onReopen={onReopenFrame} onSetNote={onSetKeyframeNote} />

      {pkg.prompt ? (
        <PackageTextSection
          title={productionTexts.packageCard.promptTitle({ approved: pkg.prompt.approved, characters: pkg.prompt.text.length })}
          text={pkg.prompt.text}
          maxHeight={220}
        />
      ) : null}

      <PackageRequest pkg={pkg} busy={busy} busyReason={busyReason} providerAvailable={providerAvailable} onSubmit={onSubmit} />

      <PackageResume
        key={`${pkg.dir}:${pkg.request?.generationId ?? ''}`}
        pkg={pkg}
        busy={busy}
        busyReason={busyReason}
        providerAvailable={providerAvailable}
        onResume={onResume}
        onAttach={onAttachResult}
        onNotCreated={onNotCreated}
      />

      <PackageResult
        pkg={pkg}
        busy={busy}
        busyReason={busyReason}
        onAccept={onAccept}
        onContactSheet={onContactSheet}
        onSelectImage={onSelectImage}
        onReopenQuestion={onReopenQuestion}
      />
      <PackageDecision
        aiKind={pkg.request?.kind === 'image' ? 'image' : 'video'}
        sendingBlocked={['submitting', 'submission_unknown'].includes(pkg.request?.attemptStatus ?? '')}
        pending={pending}
        note={note}
        setNote={setNote}
        busy={busy}
        busyReason={busyReason}
        onDecide={onDecide}
      />
      {canDiscard ? (
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          <DestructiveButton
            label={productionTexts.packageCard.discard}
            confirmLabel={productionTexts.packageCard.delete}
            startIcon={<DeleteForeverIcon />}
            variant="outlined"
            disabled={busy}
            disabledReason={busyReason}
            description={productionTexts.packageCard.discardFolder({ relative: pkg.relative, paid: paidAttempt })}
            onConfirm={onDiscard!}
          />
        </Box>
      ) : null}
      {/* Статус отправки, получения, сводки и ответов — у кнопок действий внизу карточки, где их нажимают. */}
      <JobStatus {...operation} />
    </Paper>
  );
}
