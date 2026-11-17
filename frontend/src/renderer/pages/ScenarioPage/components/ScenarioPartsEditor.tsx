import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, AlertTitle, Box, Button, List, ListItem, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { ScenesFile, TreatmentSequence } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { SCENE_PROBLEMS_ID, type EntityOption } from '../types';
import { ScenarioPartEditor } from './ScenarioPartEditor';

/**
 * Блок «Общие правила и части» над планами: логлайн, общие визуальные правила и части песни сценария. Части и
 * планы — один документ, поэтому правка части сохраняется вместе с планами и задевает их отпечатки. Пока планов
 * нет, блок показывает и проблемы частей: черновик с ними сохраняется, построение планов ждёт исправления.
 */
export function ScenarioPartsEditor({
  scenes,
  setScenes,
  expanded,
  onToggle,
  entityOptions,
  duration,
  problems,
  busy,
  hasTiming,
  updatePart,
  partsFromTiming
}: {
  scenes: ScenesFile;
  setScenes(value: ScenesFile): void;
  expanded: boolean;
  onToggle(expanded: boolean): void;
  entityOptions: EntityOption[];
  duration: number;
  /** Проблемы сценария без планов (части): с планами их показывает список планов. */
  problems: string[];
  busy: boolean;
  hasTiming: boolean;
  updatePart(index: number, patch: Partial<TreatmentSequence>): void;
  partsFromTiming(): void;
}): ReactElement {
  const shotsIn = (part: string): number => scenes.scenes.filter((shot) => shot.sequence === part).length;
  const timingReason = busy ? scenarioTexts.save.wait : scenarioTexts.prerequisites.timing;
  const anyShots = scenes.scenes.length > 0;
  return (
    <Accordion expanded={expanded} onChange={(_event, value) => onToggle(value)} disableGutters variant="outlined">
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1" component="h2">
          {scenarioTexts.treatment.title({ count: scenes.sequences.length })}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary">
            {scenarioTexts.treatment.blockHint}
          </Typography>
          <TextField
            label={scenarioTexts.fields.logline}
            value={scenes.logline}
            onChange={(e) => setScenes({ ...scenes, logline: e.target.value })}
            placeholder={scenarioTexts.treatment.loglineHint}
          />
          <TextField
            fullWidth
            multiline
            minRows={3}
            label={scenarioTexts.fields.globalVisualRules}
            value={scenes.visual_direction ?? ''}
            onChange={(e) => setScenes({ ...scenes, visual_direction: e.target.value })}
          />
          {problems.length ? (
            // Черновик частей с проблемами сохраняется, поэтому список виден над частями постоянно.
            <Alert severity="warning" id={SCENE_PROBLEMS_ID}>
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
            {scenes.sequences.map((part, index) => (
              <ScenarioPartEditor
                key={index}
                part={part}
                shots={shotsIn(part.id)}
                entityOptions={entityOptions}
                onChange={(patch) => updatePart(index, patch)}
                onRemove={() => setScenes({ ...scenes, sequences: scenes.sequences.filter((_s, i) => i !== index) })}
              />
            ))}
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              startIcon={<AddIcon />}
              color="success"
              disabled={busy}
              onClick={() =>
                setScenes({
                  ...scenes,
                  sequences: [
                    ...scenes.sequences,
                    {
                      id: `part${scenes.sequences.length + 1}`,
                      title: '',
                      direction: '',
                      start: scenes.sequences.at(-1)?.end ?? 0,
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
            {/* Части из разметки заменяют весь список; с планами состав частей меняет только новый сценарий. */}
            {scenes.sequences.length ? (
              <DestructiveButton
                label={scenarioTexts.toolbar.replaceParts}
                description={scenarioTexts.toolbar.replacePartsDescription}
                disabled={busy || !hasTiming || anyShots}
                disabledReason={anyShots ? scenarioTexts.treatment.partHasShots : timingReason}
                size="medium"
                startIcon={<TimelineIcon />}
                onConfirm={partsFromTiming}
                confirmLabel={scenarioTexts.toolbar.replacePartsConfirm}
              >
                {scenarioTexts.toolbar.partsFromTiming}
              </DestructiveButton>
            ) : (
              <ActionButton startIcon={<TimelineIcon />} onClick={partsFromTiming} disabled={busy || !hasTiming} disabledReason={timingReason}>
                {scenarioTexts.toolbar.partsFromTiming}
              </ActionButton>
            )}
          </Stack>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
