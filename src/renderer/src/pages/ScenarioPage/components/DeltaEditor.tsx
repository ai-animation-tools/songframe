import { scenarioTexts } from '@shared/texts/scenario';
import { type ReactElement, useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { CastProperty, StateDelta } from '@shared/types';
import { ActionButton, StateEditor } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';

/** Редактирует изменения выбранных сущностей поверх вычисленного состояния; каждая сущность — сворачиваемая панель. */
export function DeltaEditor({
  phase,
  reveal,
  delta,
  baseline,
  entities,
  propertiesOf,
  onChange
}: {
  phase: 'before' | 'after';
  /** Сущность, которую раскрыть по переходу из врезки. */
  reveal: string | null;
  delta: StateDelta;
  baseline: Record<string, Record<string, string>>;
  entities: { id: string; label: string }[];
  propertiesOf(entity: string): CastProperty[];
  onChange(entity: string, value: Record<string, string | null>): void;
}): ReactElement {
  const [adding, setAdding] = useState('');
  // Свёрнуты все, кроме только что добавленных: в заголовке видно, какие свойства меняются.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (entity: string, open: boolean): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(entity);
      else next.delete(entity);
      return next;
    });
  const labelOf = (entity: string): string => entities.find((e) => e.id === entity)?.label ?? entity;
  const labelOfKey = (entity: string, key: string): string => propertiesOf(entity).find((property) => property.key === key)?.label ?? key.replace(/_/g, ' ');
  // Заданные свойства блока; «меняют» — только те, что отличаются от состояния до правок блока.
  const counts = (entity: string): { set: string[]; changing: string[] } => {
    const inherited = baseline[entity] ?? {};
    const entries = Object.entries(delta[entity] ?? {}).filter(([, value]) => value === null || value.trim());
    const changing = entries.filter(([key, value]) => (value === null ? Object.hasOwn(inherited, key) : inherited[key] !== value));
    return { set: entries.map(([key]) => labelOfKey(entity, key)), changing: changing.map(([key]) => labelOfKey(entity, key)) };
  };
  const listed = Object.keys(delta);
  const available = entities.filter((entity) => !listed.includes(entity.id));
  const selectedEntity = available.find((entity) => entity.id === adding)?.id ?? '';

  useEffect(() => {
    if (reveal) toggle(reveal, true);
  }, [reveal]);

  // Удалённая или уже добавленная сущность не должна оставаться скрытым выбором.
  useEffect(() => {
    if (adding && (Object.hasOwn(delta, adding) || !entities.some((entity) => entity.id === adding))) setAdding('');
  }, [adding, delta, entities]);

  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      {!listed.length ? (
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.delta.empty}
        </Typography>
      ) : null}
      <Box sx={{ minWidth: 0 }}>
        {listed.map((entity) => {
          const { set, changing } = counts(entity);
          const same = set.length - changing.length;
          return (
            <Accordion
              key={entity}
              // По метке переход из врезки прокручивает к сущности в нужном блоке.
              data-state-entity={`${phase}:${entity}`}
              expanded={expanded.has(entity)}
              onChange={(_event, open) => toggle(entity, open)}
              disableGutters
              variant="outlined"
              sx={{ minWidth: 0, '&:not(:last-of-type)': { borderBottom: 0 } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ '& .MuiAccordionSummary-content': { minWidth: 0, alignItems: 'center', gap: 1 } }}>
                <Typography variant="body2" fontWeight={600} noWrap title={labelOf(entity)} sx={{ flexShrink: 0, maxWidth: '45%' }}>
                  {labelOf(entity)}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap title={changing.join(', ')} sx={{ flex: 1, minWidth: 0 }}>
                  {changing.join(', ')}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={same ? 'warning' : 'default'}
                  label={
                    same
                      ? scenarioTexts.delta.partialChanges({ changing: changing.length, total: set.length })
                      : scenarioTexts.delta.changes({ count: changing.length })
                  }
                  title={scenarioTexts.delta.changeSummary({ total: set.length, changing: changing.length, same })}
                  sx={{ flexShrink: 0 }}
                />
              </AccordionSummary>
              <AccordionDetails sx={{ minWidth: 0 }}>
                <StateEditor
                  compact
                  allowRemove
                  properties={propertiesOf(entity)}
                  value={delta[entity]}
                  baseline={baseline[entity] ?? {}}
                  onChange={(value) => onChange(entity, value)}
                />
                <Box sx={{ mt: 1 }}>
                  <DestructiveButton
                    label={scenarioTexts.delta.removeEntity({ name: labelOf(entity) })}
                    description={scenarioTexts.delta.removeDescription}
                    size="small"
                    startIcon={<DeleteOutlineIcon />}
                    onConfirm={() => onChange(entity, {})}
                  >
                    {scenarioTexts.delta.removeChanges}
                  </DestructiveButton>
                </Box>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
      {/* Выбор и добавление замыкают свой список (первый кадр или итог плана) и стоят слева одной строкой. */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <TextField
          select
          size="small"
          label={scenarioTexts.delta.entity}
          value={selectedEntity}
          onChange={(e) => setAdding(e.target.value)}
          disabled={!available.length}
          helperText={!available.length ? (entities.length ? scenarioTexts.delta.allAdded : scenarioTexts.delta.noEntities) : undefined}
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
            available.length ? scenarioTexts.delta.selectEntity : entities.length ? scenarioTexts.delta.allAddedReason : scenarioTexts.delta.noEntitiesReason
          }
          sx={{ mt: 0.5, flexShrink: 0 }}
          onClick={() => {
            if (!selectedEntity) return;
            onChange(selectedEntity, { [propertiesOf(selectedEntity)[0]?.key ?? 'note']: ' ' });
            toggle(selectedEntity, true);
            setAdding('');
          }}
        >
          {scenarioTexts.delta.addEntity}
        </ActionButton>
      </Box>
    </Stack>
  );
}
