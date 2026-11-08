import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { CastEntity, CastFile } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Изображения перечисляются как реальные пути, отсутствие референса явно обозначается. */
export function ScenarioCastComparison({ before, after }: { before: CastFile | null; after: CastFile | null }): ReactElement {
  const ids = [...new Set([...(before?.entities ?? []).map((entity) => entity.id), ...(after?.entities ?? []).map((entity) => entity.id)])];
  const fields: { key: keyof CastEntity; label: string }[] = [
    { key: 'kind', label: scenarioTexts.fields.kind },
    { key: 'name', label: scenarioTexts.fields.name },
    { key: 'short_name', label: scenarioTexts.fields.shortName },
    { key: 'role', label: scenarioTexts.fields.role },
    { key: 'appearance', label: scenarioTexts.fields.appearance },
    { key: 'images', label: commonTexts.files.images },
    { key: 'initial_state', label: scenarioTexts.fields.initialState }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{navigationTexts.pages.cast}</Typography>
      {!ids.length && <Typography>{scenarioTexts.comparison.noEntities}</Typography>}
      {ids.map((id) => {
        const previous = before?.entities.find((entity) => entity.id === id);
        const next = after?.entities.find((entity) => entity.id === id);
        return (
          <Stack spacing={1} key={id}>
            {next && !next.images.length && <Alert severity="warning">{scenarioTexts.comparison.imagesMissing({ name: next.name || id })}</Alert>}
            <ScenarioComparison
              title={scenarioTexts.comparison.entityTitle({ id, added: !previous, removed: !next })}
              fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
            />
          </Stack>
        );
      })}
      <ScenarioComparison
        title={scenarioTexts.comparison.propertiesTitle}
        fields={[{ label: scenarioTexts.comparison.propertiesByKind, before: before?.properties, after: after?.properties }]}
      />
    </Stack>
  );
}
