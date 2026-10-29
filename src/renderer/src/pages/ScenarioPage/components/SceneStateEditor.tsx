import type { ReactElement } from 'react';
import { Box, MenuItem, Paper, TextField, Typography } from '@mui/material';
import type { CastProperty, SceneShot, ScenesFile, StateFrom } from '@shared/types';
import type { EntityOption, ScenarioBrief } from '../types';
import { DeltaEditor } from './DeltaEditor';

/** Редактирует наследование состояния и изменения до и после плана. */
export function SceneStateEditor({
  reveal,
  shot,
  scenes,
  brief,
  entityOptions,
  propertiesOf,
  updateShot,
  setDelta
}: {
  /** Сущность и блок, которые нужно раскрыть после перехода из врезки. */
  reveal: { entity: string; phase: 'before' | 'after' } | null;
  shot: SceneShot;
  scenes: ScenesFile;
  brief: ScenarioBrief;
  entityOptions: EntityOption[];
  propertiesOf(entity: string): CastProperty[];
  updateShot(patch: Partial<SceneShot>): void;
  setDelta(phase: 'before' | 'after', entity: string, value: Record<string, string | null>): void;
}): ReactElement {
  const stateFromValue = (from: StateFrom): string => (from === null ? 'null' : typeof from === 'string' ? `after:${from}` : `${from.phase}:${from.scene}`);
  const parseStateFrom = (value: string): StateFrom => {
    if (value === 'null') return null;
    const [phase, scene] = value.split(':');
    return phase === 'after' ? scene : { scene, phase: phase as 'before' | 'same' };
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Состояние героев и мира
        </Typography>
        <TextField
          select
          size="small"
          label="Наследовать состояние"
          value={stateFromValue(shot.state_from)}
          onChange={(e) => updateShot({ state_from: parseStateFrom(e.target.value) })}
          sx={{ flex: '1 1 260px', minWidth: 0 }}
        >
          <MenuItem value="null">начало сюжета (начальное состояние кастинга)</MenuItem>
          {scenes.scenes
            .filter((s) => s.id !== shot.id)
            .flatMap((s) => [
              <MenuItem key={`after:${s.id}`} value={`after:${s.id}`}>
                после {s.id}
              </MenuItem>,
              <MenuItem key={`before:${s.id}`} value={`before:${s.id}`}>
                перед {s.id}
              </MenuItem>,
              <MenuItem key={`same:${s.id}`} value={`same:${s.id}`}>
                повтор {s.id}
              </MenuItem>
            ])}
        </TextField>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        {(['before', 'after'] as const).map((phase) => (
          <Box key={phase} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" gutterBottom>
              {phase === 'before' ? 'Первый кадр (before)' : 'Итог плана (after)'}
            </Typography>
            <DeltaEditor
              key={`${shot.id}:${phase}`}
              phase={phase}
              reveal={reveal?.phase === phase ? reveal.entity : null}
              delta={shot.state_changes[phase] ?? {}}
              // Сравнение идёт с состоянием до правок этого блока: так видно, что план действительно меняет.
              baseline={(phase === 'before' ? brief?.before.inherited : brief?.after.inherited) ?? {}}
              entities={entityOptions}
              propertiesOf={propertiesOf}
              onChange={(entity, value) => setDelta(phase, entity, value)}
            />
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
