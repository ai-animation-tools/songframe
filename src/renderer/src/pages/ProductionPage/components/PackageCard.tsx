/** Пакет производства объединяет вопрос, материалы запроса и полученный результат. */
import type { ReactElement } from 'react';
import { Alert, Box, Chip, Paper, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { VERDICT_LABELS } from '../constants';
import { isExternalPackage } from '../decisions';
import { PackageDecision } from './PackageDecision';
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
  klingAvailable,
  onDecide,
  onSubmit,
  onAccept,
  onContactSheet,
  onResume,
  onSelectImage
}: {
  pkg: PackageView;
  note: string;
  setNote(value: string): void;
  busy: boolean;
  klingAvailable: boolean;
  onDecide(verdict: string): void;
  onSubmit(): void;
  onAccept(): void;
  onContactSheet(): void;
  onResume(generationId?: string): void;
  onSelectImage(index: number): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
  return (
    <Paper variant="outlined" sx={{ p: 2, borderColor: pending ? 'primary.main' : undefined }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        <Typography fontWeight={600}>{pkg.relative}</Typography>
        <Chip size="small" label={pkg.stageLabel} color={pending ? 'primary' : 'default'} variant="outlined" />
        {pkg.retryOf ? <Chip size="small" variant="outlined" label={`повтор ${pkg.retryOf.split('/').pop()}`} /> : null}
        {pkg.waitReason ? <Chip size="small" variant="outlined" color="warning" label={pkg.waitReason} /> : null}
        <Box sx={{ flex: 1 }} />
        {pkg.decision ? (
          <Typography variant="caption" color="text.secondary">
            последний ответ: {VERDICT_LABELS[pkg.decision.verdict ?? '']?.label ?? pkg.decision.verdict}
            {pkg.decision.note ? ` («${pkg.decision.note}»)` : ''}
          </Typography>
        ) : null}
      </Box>
      {pkg.problems.length ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {pkg.problems.join(' ')}
        </Alert>
      ) : null}

      {isExternalPackage(pkg) && !pending ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          Пакетом управляет внешний агент. Приложение показывает материалы; отправку и сохранение продолжает агент.
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

      <PackageResult pkg={pkg} busy={busy} onAccept={onAccept} onContactSheet={onContactSheet} onSelectImage={onSelectImage} />
      <PackageDecision
        sendingBlocked={['submitting', 'submission_unknown'].includes(pkg.request?.attemptStatus ?? '')}
        external={isExternalPackage(pkg)}
        pending={pending}
        note={note}
        setNote={setNote}
        busy={busy}
        onDecide={onDecide}
      />
    </Paper>
  );
}
