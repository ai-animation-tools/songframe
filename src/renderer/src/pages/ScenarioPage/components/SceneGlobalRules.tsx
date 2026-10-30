import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Box, Collapse, Paper, Stack, TextField, Typography } from '@mui/material';
import type { ScenesFile } from '@shared/types';

/** Редактирует общие визуальные правила реестра и направления частей. */
export function SceneGlobalRules({
  scenes,
  setScenes,
  showGlobal
}: {
  scenes: ScenesFile;
  setScenes(value: ScenesFile): void;
  showGlobal: boolean;
}): ReactElement {
  return (
    <Collapse in={showGlobal}>
      <Paper variant="outlined" sx={{ p: 2, mb: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={4}
          label={scenarioTexts.fields.globalVisualRules}
          value={scenes.visual_direction}
          onChange={(e) => setScenes({ ...scenes, visual_direction: e.target.value })}
        />
        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
          {scenarioTexts.fields.parts}
        </Typography>
        <Stack spacing={1}>
          {scenes.sequences.map((seq, index) => (
            <Box key={seq.id} sx={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr 3fr', gap: 1 }}>
              <TextField size="small" label={scenarioTexts.fields.code} value={seq.id} disabled />
              <TextField
                size="small"
                label={scenarioTexts.fields.title}
                value={seq.title}
                onChange={(e) => setScenes({ ...scenes, sequences: scenes.sequences.map((s, i) => (i === index ? { ...s, title: e.target.value } : s)) })}
              />
              <TextField
                size="small"
                label={scenarioTexts.fields.partDirection}
                value={seq.direction}
                onChange={(e) => setScenes({ ...scenes, sequences: scenes.sequences.map((s, i) => (i === index ? { ...s, direction: e.target.value } : s)) })}
              />
            </Box>
          ))}
        </Stack>
      </Paper>
    </Collapse>
  );
}
