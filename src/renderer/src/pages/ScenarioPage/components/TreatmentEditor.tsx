import type { ReactElement } from 'react';
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { TreatmentFile, TreatmentSequence } from '@shared/types';
import type { EntityOption } from '../types';
import { TreatmentPartEditor } from './TreatmentPartEditor';

/** Редактирует логлайн и состав трактовки, включая создание вручную без разметки. */
export function TreatmentEditor({
  treatment,
  setTreatment,
  entityOptions,
  duration,
  updatePart
}: {
  treatment: TreatmentFile | null;
  setTreatment(value: TreatmentFile): void;
  entityOptions: EntityOption[];
  duration: number;
  updatePart(index: number, patch: Partial<TreatmentSequence>): void;
}): ReactElement {
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      {!treatment ? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography color="text.secondary">
            Трактовка делит песню на части и говорит, что происходит в каждой и кто участвует. Начните с частей из разметки трека или поручите первый проход
            агенту Claude Code/Codex кнопкой «Создать трактовку» выше.
          </Typography>
          <Button startIcon={<AddIcon />} color="success" onClick={() => setTreatment({ schema_version: 1, logline: '', sequences: [] })}>
            Создать вручную
          </Button>
        </Paper>
      ) : (
        <>
          <TextField
            label="Логлайн"
            value={treatment.logline}
            onChange={(e) => setTreatment({ ...treatment, logline: e.target.value })}
            placeholder="Одна фраза: о чём клип и в чём его комизм или драма"
          />
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
            Добавить часть
          </Button>
        </>
      )}
    </Stack>
  );
}
