import { type ReactElement, useEffect, useState } from 'react';
import { Box, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { CastProperty, StateDelta } from '@shared/types';
import { ActionButton, StateEditor } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';

/** Редактирует изменения выбранных сущностей поверх вычисленного состояния. */
export function DeltaEditor({
  delta,
  baseline,
  entities,
  propertiesOf,
  onChange
}: {
  delta: StateDelta;
  baseline: Record<string, Record<string, string>>;
  entities: { id: string; label: string }[];
  propertiesOf(entity: string): CastProperty[];
  onChange(entity: string, value: Record<string, string | null>): void;
}): ReactElement {
  const [adding, setAdding] = useState('');
  const listed = Object.keys(delta);
  const available = entities.filter((entity) => !listed.includes(entity.id));
  const selectedEntity = available.find((entity) => entity.id === adding)?.id ?? '';

  // Удалённая или уже добавленная сущность не должна оставаться скрытым выбором.
  useEffect(() => {
    if (adding && (Object.hasOwn(delta, adding) || !entities.some((entity) => entity.id === adding))) setAdding('');
  }, [adding, delta, entities]);

  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      {!listed.length ? (
        <Typography variant="body2" color="text.secondary">
          Изменений пока нет. Состояние наследуется.
        </Typography>
      ) : null}
      <Stack spacing={1.5} divider={<Divider />} sx={{ minWidth: 0 }}>
        {listed.map((entity) => (
          <Box key={entity} sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
                {entities.find((e) => e.id === entity)?.label ?? entity}
              </Typography>
              <DestructiveButton
                icon
                label={`Удалить изменения сущности «${entities.find((e) => e.id === entity)?.label ?? entity}»`}
                description="Все изменения этой сущности в данном блоке будут удалены. Состояние снова будет наследоваться."
                onConfirm={() => onChange(entity, {})}
              >
                <DeleteOutlineIcon fontSize="inherit" />
              </DestructiveButton>
            </Box>
            <StateEditor
              compact
              allowRemove
              properties={propertiesOf(entity)}
              value={delta[entity]}
              baseline={baseline[entity] ?? {}}
              onChange={(value) => onChange(entity, value)}
            />
          </Box>
        ))}
      </Stack>
      {/* Выбор и добавление замыкают свой список (первый кадр или итог плана) и стоят слева одной строкой. */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <TextField
          select
          size="small"
          label="Сущность для изменения"
          value={selectedEntity}
          onChange={(e) => setAdding(e.target.value)}
          disabled={!available.length}
          helperText={!available.length ? (entities.length ? 'Все сущности уже добавлены' : 'В кастинге пока нет сущностей') : undefined}
          sx={{ flex: '1 1 220px', minWidth: 0, maxWidth: 360 }}
        >
          {available.map((entity) => (
            <MenuItem key={entity.id} value={entity.id}>
              {entity.label}
            </MenuItem>
          ))}
        </TextField>
        <ActionButton
          size="small"
          color="success"
          startIcon={<AddIcon />}
          disabled={!selectedEntity}
          disabledReason={
            available.length ? 'Сначала выберите сущность для изменения.' : entities.length ? 'Все сущности уже добавлены.' : 'В кастинге пока нет сущностей.'
          }
          sx={{ mt: 0.5, flexShrink: 0 }}
          onClick={() => {
            if (!selectedEntity) return;
            onChange(selectedEntity, { [propertiesOf(selectedEntity)[0]?.key ?? 'note']: ' ' });
            setAdding('');
          }}
        >
          Добавить сущность
        </ActionButton>
      </Box>
    </Stack>
  );
}
