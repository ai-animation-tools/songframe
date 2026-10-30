import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Autocomplete, Box, Checkbox, FormControlLabel, Paper, TextField } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { TreatmentSequence } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { EntityOption } from '../types';

/** Редактирует одну часть трактовки, её участников и ограничения планов. */
export function TreatmentPartEditor({
  part,
  entityOptions,
  onChange,
  onRemove
}: {
  part: TreatmentSequence;
  entityOptions: EntityOption[];
  onChange(patch: Partial<TreatmentSequence>): void;
  onRemove(): void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0, containerType: 'inline-size', containerName: 'treatment-part' }}>
      {/* Число полей в строке зависит от ширины самой части, включая двухколоночный режим трактовки. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          '@container treatment-part (min-width: 850px)': { gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 2fr) repeat(3, minmax(0, 1fr)) auto' },
          gap: 1.5,
          alignItems: 'start',
          '& > *': { minWidth: 0 }
        }}
      >
        <TextField label={scenarioTexts.fields.code} value={part.id} onChange={(e) => onChange({ id: e.target.value })} />
        <TextField label={scenarioTexts.fields.title} value={part.title} onChange={(e) => onChange({ title: e.target.value })} />
        <TextField
          label={scenarioTexts.fields.startSeconds}
          type="number"
          value={part.start}
          onChange={(e) => onChange({ start: Number(e.target.value) })}
          inputProps={{ step: 0.01 }}
        />
        <TextField
          label={scenarioTexts.fields.endSeconds}
          type="number"
          value={part.end}
          onChange={(e) => onChange({ end: Number(e.target.value) })}
          inputProps={{ step: 0.01 }}
        />
        <TextField
          label={scenarioTexts.fields.maxShotShortSeconds}
          type="number"
          value={part.max_shot_seconds ?? 6}
          onChange={(e) => onChange({ max_shot_seconds: Number(e.target.value) })}
          inputProps={{ step: 1, min: 2 }}
        />
        <DestructiveButton
          icon
          label={scenarioTexts.treatment.deletePart({ title: part.title, id: part.id })}
          description={scenarioTexts.treatment.deleteDescription}
          onConfirm={onRemove}
        >
          <DeleteOutlineIcon />
        </DestructiveButton>
      </Box>
      <TextField
        fullWidth
        multiline
        minRows={2}
        label={scenarioTexts.treatment.direction}
        value={part.direction}
        onChange={(e) => onChange({ direction: e.target.value })}
        sx={{ mt: 1.5 }}
      />
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
        <Autocomplete
          multiple
          size="small"
          options={entityOptions}
          getOptionLabel={(o) => o.label}
          value={entityOptions.filter((o) => part.entities.includes(o.id))}
          onChange={(_e, value) => onChange({ entities: value.map((v) => v.id) })}
          renderInput={(params) => <TextField {...params} label={scenarioTexts.fields.entities} />}
          sx={{ flex: 1, minWidth: 'min(100%, 320px)' }}
        />
        <FormControlLabel
          control={<Checkbox checked={!!part.lipsync} onChange={(e) => onChange({ lipsync: e.target.checked })} />}
          label={scenarioTexts.treatment.singing}
        />
      </Box>
    </Paper>
  );
}
