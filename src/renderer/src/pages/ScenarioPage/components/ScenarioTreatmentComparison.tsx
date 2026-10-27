import type { ReactElement } from 'react';
import { Stack, Typography } from '@mui/material';
import type { TreatmentFile, TreatmentSequence } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Сравнение трактовки раскрывает действие и состав каждой части песни. */
export function ScenarioTreatmentComparison({ before, after }: { before: TreatmentFile | null; after: TreatmentFile | null }): ReactElement {
  const ids = [...new Set([...(before?.sequences ?? []).map((part) => part.id), ...(after?.sequences ?? []).map((part) => part.id)])];
  const fields: { key: keyof TreatmentSequence; label: string }[] = [
    { key: 'title', label: 'Название' },
    { key: 'start', label: 'Начало, с' },
    { key: 'end', label: 'Конец, с' },
    { key: 'direction', label: 'Действие' },
    { key: 'entities', label: 'Участники' },
    { key: 'lipsync', label: 'Lipsync' },
    { key: 'max_shot_seconds', label: 'Максимум плана, с' }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Трактовка</Typography>
      <ScenarioComparison title="Логлайн" fields={[{ label: 'О чём клип', before: before?.logline, after: after?.logline }]} />
      {ids.map((id) => {
        const previous = before?.sequences.find((part) => part.id === id);
        const next = after?.sequences.find((part) => part.id === id);
        return (
          <ScenarioComparison
            key={id}
            title={`Часть ${id}${!previous ? ' · новая' : !next ? ' · удаление' : ''}`}
            fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
          />
        );
      })}
    </Stack>
  );
}
