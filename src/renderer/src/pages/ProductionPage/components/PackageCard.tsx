/** Пакет производства объединяет вопрос, материалы запроса и полученный результат. */
import type { ReactElement } from 'react';
import { Alert, Box, Chip, Paper, Typography } from '@mui/material';
import type { JobInfo, PackageView } from '@shared/types';
import { JobStatus } from '../../../components/JobStatus';
import { DestructiveButton } from '../../../components/DestructiveButton';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { VERDICT_LABELS } from '../constants';
import { isQueuedPackage } from '../decisions';
import { PackageDecision } from './PackageDecision';
import { PackageRevisionNotice } from './PackageRevisionNotice';
import { PackageKeyframes } from './PackageKeyframes';
import { PackageRequest } from './PackageRequest';
import { PackageResume } from './PackageResume';
import { PackageResult } from './PackageResult';
import { PackageTextSection } from './PackageTextSection';

export function PackageCard({
  pkg,
  note,
  setNote,
  busy,
  operation,
  klingAvailable,
  onDecide,
  onSubmit,
  onAccept,
  onContactSheet,
  onReopenQuestion,
  onDiscard,
  onResume,
  onSelectImage,
  onOpenRevision
}: {
  pkg: PackageView;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  operation?: { job?: JobInfo; error?: string; running?: boolean; label?: string };
  klingAvailable: boolean;
  onDecide(verdict: string): void;
  onSubmit(): void;
  onAccept(): void;
  onContactSheet(): void;
  onReopenQuestion?(): void;
  /** Удалить попытку целиком; доступно пакету приложения вне незавершённой отправки. */
  onDiscard?(): void;
  onResume(generationId?: string): void;
  onSelectImage(index: number): void;
  onOpenRevision?(): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
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
        {pkg.retryOf ? <Chip size="small" variant="outlined" label={`повтор ${pkg.retryOf.split('/').pop()}`} /> : null}
        {pkg.waitReason ? <Chip size="small" variant="outlined" color="warning" label={pkg.waitReason} /> : null}
        <Box sx={{ flex: 1 }} />
        {pkg.decision && !returnedForRevision ? (
          <Typography variant="caption" color="text.secondary">
            последний ответ: {VERDICT_LABELS[pkg.decision.verdict ?? '']?.label ?? pkg.decision.verdict}
            {pkg.decision.note ? ` («${pkg.decision.note}»)` : ''}
          </Typography>
        ) : null}
      </Box>
      <JobStatus {...operation} />
      <PackageRevisionNotice pkg={pkg} onOpenRevision={onOpenRevision} />
      {isQueuedPackage(pkg) ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          Запрос сохранён в очереди, генерация не запущена. Нажмите «Отправить» ниже: приложение заново проверит стоимость и покажет подтверждение перед
          списанием кредитов.
        </Alert>
      ) : null}
      {pkg.problems.length ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {pkg.problems.join(' ')}
        </Alert>
      ) : null}

      {pkg.description ? <PackageTextSection title="Описание плана" text={pkg.description} maxHeight={260} /> : null}

      <PackageKeyframes pkg={pkg} />

      {pkg.prompt ? (
        <PackageTextSection
          title={`Видеопромпт ${pkg.prompt.approved ? '· принят' : '· не принят'} · ${pkg.prompt.text.length} символов`}
          text={pkg.prompt.text}
          maxHeight={220}
        />
      ) : null}

      <PackageRequest pkg={pkg} busy={busy} klingAvailable={klingAvailable} onSubmit={onSubmit} />

      <PackageResume key={`${pkg.dir}:${pkg.request?.generationId ?? ''}`} pkg={pkg} busy={busy} klingAvailable={klingAvailable} onResume={onResume} />

      <PackageResult
        pkg={pkg}
        busy={busy}
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
        onDecide={onDecide}
      />
      {canDiscard ? (
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          <DestructiveButton
            label="Отказаться от попытки"
            confirmLabel="Удалить попытку"
            startIcon={<DeleteForeverIcon />}
            variant="outlined"
            disabled={busy}
            description={
              `Папка ${pkg.relative} будет удалена безвозвратно вместе с запросом, опорами и промптом` +
              (paidAttempt ? ', включая оплаченный оригинал генерации: кредиты не возвращаются' : '') +
              '. Принятый комплект сцены и исходники не затрагиваются; после удаления снова доступны новая подготовка и «Подготовить повтор».'
            }
            onConfirm={onDiscard!}
          />
        </Box>
      ) : null}
    </Paper>
  );
}
