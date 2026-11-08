import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Stack, Typography } from '@mui/material';
import type { TreatmentFile, TreatmentSequence } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Сравнение трактовки раскрывает действие и состав каждой части песни. */
export function ScenarioTreatmentComparison({ before, after }: { before: TreatmentFile | null; after: TreatmentFile | null }): ReactElement {
  const ids = [...new Set([...(before?.sequences ?? []).map((part) => part.id), ...(after?.sequences ?? []).map((part) => part.id)])];
  const fields: { key: keyof TreatmentSequence; label: string }[] = [
    { key: 'title', label: scenarioTexts.fields.title },
    { key: 'start', label: scenarioTexts.fields.startSeconds },
    { key: 'end', label: scenarioTexts.fields.endSeconds },
    { key: 'direction', label: scenarioTexts.fields.action },
    { key: 'entities', label: scenarioTexts.fields.entities },
    { key: 'lipsync', label: scenarioTexts.fields.lipsync },
    { key: 'max_shot_seconds', label: scenarioTexts.fields.maxShotSeconds }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{scenarioTexts.fields.treatment}</Typography>
      <ScenarioComparison
        title={scenarioTexts.fields.logline}
        fields={[{ label: scenarioTexts.fields.aboutClip, before: before?.logline, after: after?.logline }]}
      />
      {ids.map((id) => {
        const previous = before?.sequences.find((part) => part.id === id);
        const next = after?.sequences.find((part) => part.id === id);
        return (
          <ScenarioComparison
            key={id}
            title={scenarioTexts.comparison.partTitle({ id, added: !previous, removed: !next })}
            fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
          />
        );
      })}
    </Stack>
  );
}
