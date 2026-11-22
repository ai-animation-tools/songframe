import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { alpha, Box, MenuItem, Paper, TextField, Typography } from '@mui/material';
import type { CastProperty, SceneShot, ScenesFile, StateFrom } from '@shared/types';
import type { EntityOption, ScenarioBrief } from '../types';
import { DeltaEditor } from './DeltaEditor';

/** Редактирует наследование состояния и изменения до и после плана. */
export function SceneStateEditor({
  resetKey,
  reveal,
  shot,
  scenes,
  brief,
  entityOptions,
  propertiesOf,
  updateShot,
  setDelta,
  locked = false
}: {
  resetKey?: object | null;
  /** Сущность и блок, которые нужно раскрыть после перехода из врезки. */
  reveal: { entity: string; phase: 'before' | 'after' } | null;
  shot: SceneShot;
  scenes: ScenesFile;
  brief: ScenarioBrief;
  entityOptions: EntityOption[];
  propertiesOf(entity: string): CastProperty[];
  updateShot(patch: Partial<SceneShot>): void;
  setDelta(phase: 'before' | 'after', entity: string, value: Record<string, string | null>): void;
  /** Принятый план: наследование и изменения состояния только для чтения. */
  locked?: boolean;
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
          {scenarioTexts.state.title}
        </Typography>
        <TextField
          select
          size="small"
          label={scenarioTexts.state.inherit}
          value={stateFromValue(shot.state_from)}
          onChange={(e) => updateShot({ state_from: parseStateFrom(e.target.value) })}
          disabled={locked}
          sx={{ flex: '1 1 260px', minWidth: 0 }}
        >
          <MenuItem value="null">{scenarioTexts.state.start}</MenuItem>
          {scenes.scenes
            .filter((s) => s.id !== shot.id)
            .flatMap((s) => [
              <MenuItem key={`after:${s.id}`} value={`after:${s.id}`}>
                {scenarioTexts.state.after({ shot: s.id })}
              </MenuItem>,
              <MenuItem key={`before:${s.id}`} value={`before:${s.id}`}>
                {scenarioTexts.state.before({ shot: s.id })}
              </MenuItem>,
              <MenuItem key={`same:${s.id}`} value={`same:${s.id}`}>
                {scenarioTexts.state.repeat({ shot: s.id })}
              </MenuItem>
            ])}
        </TextField>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        {(['before', 'after'] as const).map((phase) => {
          // Колонки различаются цветом полосы и заголовка из палитры темы: primary — начало плана, secondary — его конец.
          // В светлой теме заголовок берёт тёмный оттенок: основной оранжевый на светлом фоне не даёт контраста текста AA.
          const color = phase === 'before' ? 'primary' : 'secondary';
          return (
            <Box
              key={phase}
              data-testid={`state-column-${phase}`}
              sx={(theme) => ({
                minWidth: 0,
                p: 1.5,
                borderRadius: 1,
                border: 1,
                borderColor: 'divider',
                borderTop: 4,
                borderTopColor: `${color}.main`,
                bgcolor: alpha(theme.palette[color].main, theme.palette.mode === 'dark' ? 0.08 : 0.04)
              })}
            >
              <Typography
                variant="h6"
                component="h3"
                sx={(theme) => ({ lineHeight: 1.3, color: theme.palette.mode === 'dark' ? theme.palette[color].main : theme.palette[color].dark })}
              >
                {phase === 'before' ? scenarioTexts.state.beforeHeading : scenarioTexts.state.afterHeading}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                {phase === 'before' ? scenarioTexts.state.beforeHeadingHint : scenarioTexts.state.afterHeadingHint}
              </Typography>
              <DeltaEditor
                resetKey={resetKey}
                key={`${shot.id}:${phase}`}
                phase={phase}
                reveal={reveal?.phase === phase ? reveal.entity : null}
                delta={shot.state_changes[phase] ?? {}}
                // Сравнение идёт с состоянием до правок этого блока: так видно, что план действительно меняет.
                baseline={(brief?.[phase].shot === shot.id ? brief[phase].inherited : undefined) ?? {}}
                entities={entityOptions}
                propertiesOf={propertiesOf}
                onChange={(entity, value) => setDelta(phase, entity, value)}
                locked={locked}
              />
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}
