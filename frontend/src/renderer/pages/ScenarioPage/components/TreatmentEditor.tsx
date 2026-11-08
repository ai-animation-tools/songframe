import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Alert, AlertTitle, Box, Button, List, ListItem, Paper, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { TreatmentFile, TreatmentSequence } from '@shared/types';
import { TREATMENT_PROBLEMS_ID, type EntityOption } from '../types';
import { TreatmentPartEditor } from './TreatmentPartEditor';

/** Редактирует логлайн и состав трактовки, включая создание вручную без разметки. */
export function TreatmentEditor({
  treatment,
  setTreatment,
  entityOptions,
  duration,
  problems,
  updatePart
}: {
  treatment: TreatmentFile | null;
  setTreatment(value: TreatmentFile): void;
  entityOptions: EntityOption[];
  duration: number;
  /** Проблемы текущего черновика: видны постоянно, пока их не исправят, и не мешают сохранению. */
  problems: string[];
  updatePart(index: number, patch: Partial<TreatmentSequence>): void;
}): ReactElement {
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      {!treatment ? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography color="text.secondary">{scenarioTexts.treatment.emptyHint}</Typography>
          <Button startIcon={<AddIcon />} color="success" onClick={() => setTreatment({ schema_version: 1, logline: '', sequences: [] })}>
            {scenarioTexts.treatment.createManually}
          </Button>
        </Paper>
      ) : (
        <>
          <TextField
            label={scenarioTexts.fields.logline}
            value={treatment.logline}
            onChange={(e) => setTreatment({ ...treatment, logline: e.target.value })}
            placeholder={scenarioTexts.treatment.loglineHint}
          />
          {problems.length ? (
            // Черновик с проблемами сохраняется, поэтому список виден над частями постоянно.
            <Alert severity="warning" id={TREATMENT_PROBLEMS_ID}>
              <AlertTitle>{scenarioTexts.treatment.problemsTitle}</AlertTitle>
              <Typography variant="body2">{scenarioTexts.treatment.problemsHint}</Typography>
              <List dense disablePadding sx={{ listStyleType: 'disc', pl: 2.5, mt: 0.5 }}>
                {problems.map((problem, index) => (
                  <ListItem key={`${index}:${problem}`} disablePadding sx={{ display: 'list-item' }}>
                    {problem}
                  </ListItem>
                ))}
              </List>
            </Alert>
          ) : null}
          {/* Части сохраняют порядок песни и занимают две колонки только в широкой рабочей области. */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
              gap: 2,
              alignItems: 'start'
            }}
          >
            {treatment.sequences.map((part, index) => (
              <TreatmentPartEditor
                key={index}
                part={part}
                entityOptions={entityOptions}
                onChange={(patch) => updatePart(index, patch)}
                onRemove={() => setTreatment({ ...treatment, sequences: treatment.sequences.filter((_s, i) => i !== index) })}
              />
            ))}
          </Box>
          <Button
            startIcon={<AddIcon />}
            color="success"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() =>
              setTreatment({
                ...treatment,
                sequences: [
                  ...treatment.sequences,
                  {
                    id: `part${treatment.sequences.length + 1}`,
                    title: '',
                    direction: '',
                    start: treatment.sequences.at(-1)?.end ?? 0,
                    end: duration,
                    entities: [],
                    lipsync: false,
                    max_shot_seconds: 6
                  }
                ]
              })
            }
          >
            {scenarioTexts.treatment.addPart}
          </Button>
        </>
      )}
    </Stack>
  );
}
