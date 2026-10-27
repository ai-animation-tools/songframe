import type { ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { CastEntity, CastFile } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Изображения перечисляются как реальные пути, отсутствие референса явно обозначается. */
export function ScenarioCastComparison({ before, after }: { before: CastFile | null; after: CastFile | null }): ReactElement {
  const ids = [...new Set([...(before?.entities ?? []).map((entity) => entity.id), ...(after?.entities ?? []).map((entity) => entity.id)])];
  const fields: { key: keyof CastEntity; label: string }[] = [
    { key: 'kind', label: 'Тип' },
    { key: 'name', label: 'Имя' },
    { key: 'short_name', label: 'Краткое имя' },
    { key: 'role', label: 'Роль' },
    { key: 'appearance', label: 'Образ' },
    { key: 'images', label: 'Изображения' },
    { key: 'initial_state', label: 'Начальное состояние' }
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Кастинг</Typography>
      {!ids.length && <Typography>Сущностей нет.</Typography>}
      {ids.map((id) => {
        const previous = before?.entities.find((entity) => entity.id === id);
        const next = after?.entities.find((entity) => entity.id === id);
        return (
          <Stack spacing={1} key={id}>
            {next && !next.images.length && <Alert severity="warning">{next.name || id}: изображения отсутствуют. Референс ещё нужно подготовить.</Alert>}
            <ScenarioComparison
              title={`${id}${!previous ? ' · новая сущность' : !next ? ' · удаление' : ''}`}
              fields={fields.map(({ key, label }) => ({ label, before: previous?.[key], after: next?.[key] }))}
            />
          </Stack>
        );
      })}
      <ScenarioComparison title="Словарь свойств" fields={[{ label: 'Свойства по типам', before: before?.properties, after: after?.properties }]} />
    </Stack>
  );
}
