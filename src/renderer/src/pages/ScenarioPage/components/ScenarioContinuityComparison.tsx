import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { EntityState, ScenesFile } from '@shared/types';
import { ScenarioComparison } from './ScenarioComparison';

/** Влияние на соседей вычисляется по двум полным реестрам без записи candidate в проект. */
export function ScenarioContinuityComparison({
  project,
  before,
  after,
  selectedIds
}: {
  project: string;
  before: ScenesFile;
  after: ScenesFile;
  selectedIds: string[];
}): ReactElement {
  const [changes, setChanges] = useState<{ id: string; before: EntityState; after: EntityState }[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setChanges(null);
    setError(false);
    const successors = after.scenes.filter((shot) => !selectedIds.includes(shot.id) && before.scenes.some((old) => old.id === shot.id));
    Promise.all(
      successors.map(async (shot) => {
        const [previous, next] = await Promise.all([
          window.api.scenario.brief(project, before, shot.id, 'before'),
          window.api.scenario.brief(project, after, shot.id, 'before')
        ]);
        return { id: shot.id, before: previous.state, after: next.state };
      })
    ).then(
      (values) => {
        if (active) setChanges(values.filter((value) => JSON.stringify(value.before) !== JSON.stringify(value.after)));
      },
      () => {
        if (active) setError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [project, before, after, selectedIds]);
  return (
    <Stack spacing={1}>
      <Typography variant="h6">Влияние на наследуемые состояния</Typography>
      {error ? (
        <Alert severity="warning">Не удалось рассчитать сравнение состояний соседей. Проверьте continuity перед применением.</Alert>
      ) : changes === null ? (
        <Typography>Проверяем состояния остальных планов…</Typography>
      ) : changes.length ? (
        changes.map((change) => (
          <ScenarioComparison
            key={change.id}
            title={`Состояние перед ${change.id}`}
            fields={[{ label: 'Состояние сущностей', before: change.before, after: change.after }]}
          />
        ))
      ) : (
        <Typography>Наследуемые состояния остальных планов не изменились.</Typography>
      )}
    </Stack>
  );
}
