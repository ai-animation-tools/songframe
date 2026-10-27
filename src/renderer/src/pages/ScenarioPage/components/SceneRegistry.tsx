import type { ReactElement } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import type { CastProperty, ScenesFile } from '@shared/types';
import type { EntityOption, ScenarioBrief } from '../types';
import { useSceneDraft } from '../useSceneDraft';
import { SceneGlobalRules } from './SceneGlobalRules';
import { SceneTimeline } from './SceneTimeline';
import { SceneList } from './SceneList';
import { SceneShotEditor } from './SceneShotEditor';
import { SceneStateEditor } from './SceneStateEditor';
import { ContinuityBrief } from './ContinuityBrief';

/** Собирает реестр из списка, шкалы и редакторов выбранного плана. */
export function SceneRegistry({
  scenes,
  setScenes,
  selected,
  setSelected,
  showGlobal,
  problems,
  duration,
  brief,
  entityOptions,
  referenceOptions,
  propertiesOf,
  copy,
  notify
}: {
  scenes: ScenesFile;
  setScenes: Dispatch<SetStateAction<ScenesFile | null>>;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  showGlobal: boolean;
  problems: string[];
  duration: number;
  brief: ScenarioBrief;
  entityOptions: EntityOption[];
  referenceOptions: EntityOption[];
  propertiesOf(entity: string): CastProperty[];
  copy(text: string): Promise<void>;
  notify(message: string, severity: 'warning'): void;
}): ReactElement {
  const { shot, shotIndex, updateShot, setBoundary, split, mergeNext, setDelta } = useSceneDraft(scenes, selected, setScenes, setSelected, notify);
  return (
    <>
      <SceneGlobalRules scenes={scenes} setScenes={setScenes} showGlobal={showGlobal} />
      {problems.length ? (
        <Alert severity="warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 8 ? <li>… и ещё {problems.length - 8}</li> : null}
          </ul>
        </Alert>
      ) : null}
      <SceneTimeline scenes={scenes} duration={duration} selected={selected} onSelect={setSelected} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '300px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <SceneList scenes={scenes} selected={selected} onSelect={setSelected} />
        {shot ? (
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            <SceneShotEditor
              shot={shot}
              shotIndex={shotIndex}
              scenes={scenes}
              referenceOptions={referenceOptions}
              updateShot={updateShot}
              setBoundary={setBoundary}
              split={split}
              mergeNext={mergeNext}
            />
            <SceneStateEditor
              shot={shot}
              scenes={scenes}
              brief={brief}
              entityOptions={entityOptions}
              propertiesOf={propertiesOf}
              updateShot={updateShot}
              setDelta={setDelta}
            />
            <ContinuityBrief brief={brief} copy={copy} />
          </Stack>
        ) : (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">Выберите план.</Typography>
          </Paper>
        )}
      </Box>
    </>
  );
}
