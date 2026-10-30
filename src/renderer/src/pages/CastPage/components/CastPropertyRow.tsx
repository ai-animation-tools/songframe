import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Autocomplete, Box, Chip, Paper, TextField, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { CastProperty } from '@shared/types';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { propertyLabelProblem, propertyValues } from '../properties';

interface CastPropertyRowProps {
  property: CastProperty;
  /** Новое несохранённое свойство: только у него можно менять код. */
  fresh: boolean;
  keyProblem: string | null;
  kindLabel: string;
  /** Сколько сущностей типа уже хранят значение под этим кодом в начальном состоянии. */
  usage: number;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: (patch: Partial<CastProperty>) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
}

/** Строка словаря: краткая сводка с действиями записи и раскрываемые поля свойства. */
export function CastPropertyRow({
  property,
  fresh,
  keyProblem,
  kindLabel,
  usage,
  first,
  last,
  expanded,
  onExpandedChange,
  onChange,
  onMove,
  onRemove
}: CastPropertyRowProps): ReactElement {
  const name = property.label.trim() || property.key || castTexts.unlabeledProperty;
  const labelProblem = propertyLabelProblem(property.label);
  const checklistWithoutValue = Boolean(property.checklist?.trim()) && !property.checklist?.includes('{value}');
  const removeDescription = fresh
    ? castTexts.removeFreshPropertyDescription
    : castTexts.removePropertyDescription({ kind: kindLabel, key: property.key, usage });
  return (
    <Paper variant="outlined" sx={{ p: 1.5, minWidth: 0 }}>
      {/* Сводка переносится по ширине: действия записи остаются в строке справа. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flex: 1, minWidth: 0 }}>
          <Typography fontWeight={600} noWrap title={name} sx={{ minWidth: 0 }}>
            {name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={fresh ? undefined : castTexts.propertyCodeImmutable}
            sx={{ fontFamily: 'monospace', flexShrink: 0 }}
          >
            {property.key}
          </Typography>
        </Box>
        {fresh ? <Chip size="small" variant="outlined" color="success" label={castTexts.newProperty} /> : null}
        {property.values?.length ? <Chip size="small" variant="outlined" label={castTexts.valuesCount({ count: property.values.length })} /> : null}
        {property.checklist?.trim() ? <Chip size="small" variant="outlined" label={castTexts.hasChecklist} /> : null}
        {keyProblem || labelProblem ? <Chip size="small" variant="outlined" color="error" label={castTexts.propertyInvalid} /> : null}
        <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <ActionIconButton
            size="small"
            aria-label={castTexts.movePropertyUp({ name })}
            title={castTexts.movePropertyUpHint}
            disabled={first}
            disabledReason={castTexts.propertyAlreadyFirst}
            onClick={() => onMove(-1)}
          >
            <ArrowUpwardIcon fontSize="small" />
          </ActionIconButton>
          <ActionIconButton
            size="small"
            aria-label={castTexts.movePropertyDown({ name })}
            title={castTexts.movePropertyDownHint}
            disabled={last}
            disabledReason={castTexts.propertyAlreadyLast}
            onClick={() => onMove(1)}
          >
            <ArrowDownwardIcon fontSize="small" />
          </ActionIconButton>
          <ActionIconButton
            size="small"
            aria-label={expanded ? castTexts.collapseProperty({ name }) : castTexts.editProperty({ name })}
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <EditOutlinedIcon fontSize="small" />}
          </ActionIconButton>
          <DestructiveButton icon label={castTexts.removeProperty({ name })} description={removeDescription} onConfirm={onRemove}>
            <DeleteOutlineIcon fontSize="small" />
          </DestructiveButton>
        </Box>
      </Box>
      {expanded ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            '@container workspace (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5,
            mt: 1.5,
            alignItems: 'start'
          }}
        >
          {fresh ? (
            <TextField
              size="small"
              label={commonTexts.code}
              required
              value={property.key}
              onChange={(e) => onChange({ key: e.target.value })}
              error={Boolean(keyProblem)}
              helperText={keyProblem ?? castTexts.propertyCodeHint}
              slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' } } }}
              sx={{ gridColumn: '1 / -1' }}
            />
          ) : null}
          <TextField
            size="small"
            label={commonTexts.label}
            required
            value={property.label}
            onChange={(e) => onChange({ label: e.target.value })}
            error={Boolean(labelProblem)}
            helperText={labelProblem ?? castTexts.propertyLabelHint}
          />
          <TextField
            size="small"
            label={castTexts.propertyHint}
            value={property.hint ?? ''}
            onChange={(e) => onChange({ hint: e.target.value })}
            helperText={castTexts.propertyHintHelp}
          />
          <Autocomplete
            multiple
            freeSolo
            // Набранный, но не подтверждённый Enter вариант не теряется при уходе из поля.
            autoSelect
            size="small"
            options={[]}
            value={property.values ?? []}
            onChange={(_e, next) => onChange({ values: propertyValues(next) })}
            renderInput={(params) => (
              <TextField
                {...params}
                label={castTexts.propertyValues}
                placeholder={property.values?.length ? undefined : castTexts.propertyValuePlaceholder}
                helperText={castTexts.propertyValuesHelp}
              />
            )}
          />
          <TextField
            size="small"
            label={castTexts.propertyChecklist}
            value={property.checklist ?? ''}
            onChange={(e) => onChange({ checklist: e.target.value })}
            placeholder={castTexts.propertyChecklistPlaceholder}
            helperText={castTexts.checklistHelp({ withoutValue: checklistWithoutValue })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Box>
      ) : null}
    </Paper>
  );
}
