import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useRef, type ReactElement } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import type { CastFile, CastProperty, ScenesFile } from '@shared/types';
import { SCENE_PROBLEMS_ID, type EntityOption, type OpenShotState, type ScenarioBrief, type ShotReveal } from '../types';
import { useSceneDraft } from '../useSceneDraft';
import { SceneGlobalRules } from './SceneGlobalRules';
import { SceneTimeline } from './SceneTimeline';
import { SceneList } from './SceneList';
import { SceneShotEditor } from './SceneShotEditor';
import { SceneStateEditor } from './SceneStateEditor';
import { ContinuityBrief } from './ContinuityBrief';
import { coveredArea, revealAnchor } from '../../../hooks/useAnchorTarget';

/** Собирает реестр из списка, шкалы и редакторов выбранного плана. */
export function SceneRegistry({
  scenes,
  setScenes,
  stickyTop,
  selected,
  setSelected,
  revealShot,
  onRevealed,
  onOpenShotState,
  leaveReason,
  showGlobal,
  problems,
  duration,
  brief,
  cast,
  entityOptions,
  referenceOptions,
  propertiesOf,
  notify
}: {
  scenes: ScenesFile;
  setScenes: Dispatch<SetStateAction<ScenesFile | null>>;
  /** Отступ закреплённого списка под шапкой и панелью действий страницы. */
  stickyTop: number;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  /** План, открытый переходом или источником врезки: список и редактор (постановки или состояния) прокручиваются к нему один раз. */
  revealShot: ShotReveal | null;
  onRevealed(): void;
  /** Выбрать план и прокрутить к его блоку «Состояние героев и мира». */
  onOpenShotState: OpenShotState;
  /** Причина, по которой уход на другую страницу сейчас потеряет правки. */
  leaveReason: string | null;
  showGlobal: boolean;
  problems: string[];
  duration: number;
  brief: ScenarioBrief;
  cast: CastFile | null;
  entityOptions: EntityOption[];
  referenceOptions: EntityOption[];
  propertiesOf(entity: string): CastProperty[];
  notify(message: string, severity: 'warning'): void;
}): ReactElement {
  const { shot, shotIndex, updateShot, setBoundary, split, mergeNext, setDelta } = useSceneDraft(scenes, selected, setScenes, setSelected, notify);
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<HTMLDivElement>(null);
  // Строка списка прокручивается внутри своей области, затем окно — к нужному редактору с учётом закреплённых шапки и панели.
  useEffect(() => {
    if (!revealShot || shot?.id !== revealShot.shot) return;
    listRef.current?.querySelector<HTMLElement>(`[data-shot-id="${CSS.escape(revealShot.shot)}"]`)?.scrollIntoView({ block: 'nearest' });
    // Переход из врезки ведёт к самой сущности в нужном блоке состояния, если она там задана.
    const entity =
      revealShot.target === 'state' && revealShot.entity && revealShot.phase
        ? stateRef.current?.querySelector<HTMLElement>(`[data-state-entity="${CSS.escape(`${revealShot.phase}:${revealShot.entity}`)}"]`)
        : null;
    const target = entity ?? (revealShot.target === 'state' ? stateRef.current : editorRef.current);
    if (target) revealAnchor(target, coveredArea(document), window.innerHeight);
    onRevealed();
  }, [revealShot, shot?.id, onRevealed]);
  return (
    <>
      <SceneGlobalRules scenes={scenes} setScenes={setScenes} showGlobal={showGlobal} />
      {problems.length ? (
        <Alert id={SCENE_PROBLEMS_ID} severity="warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 8 ? <li>{scenarioTexts.registry.moreProblems({ count: problems.length - 8 })}</li> : null}
          </ul>
        </Alert>
      ) : null}
      <SceneTimeline scenes={scenes} duration={duration} selected={selected} onSelect={setSelected} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '300px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        {/* В двух колонках список закреплён под панелью страницы и прокручивается сам, пока редактор плана листается. */}
        <Box ref={listRef} sx={{ minWidth: 0, position: { lg: 'sticky' }, top: { lg: stickyTop } }}>
          <SceneList scenes={scenes} selected={selected} onSelect={setSelected} maxHeight={{ xs: '50vh', lg: `calc(100vh - ${stickyTop + 16}px)` }} />
        </Box>
        {shot ? (
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            <Box ref={editorRef} sx={{ minWidth: 0 }}>
              <SceneShotEditor
                shot={shot}
                shotIndex={shotIndex}
                scenes={scenes}
                referenceOptions={referenceOptions}
                leaveReason={leaveReason}
                updateShot={updateShot}
                setBoundary={setBoundary}
                split={split}
                mergeNext={mergeNext}
              />
            </Box>
            <Box ref={stateRef} sx={{ minWidth: 0 }}>
              <SceneStateEditor
                reveal={
                  revealShot?.target === 'state' && revealShot.shot === shot.id && revealShot.entity && revealShot.phase
                    ? { entity: revealShot.entity, phase: revealShot.phase }
                    : null
                }
                shot={shot}
                scenes={scenes}
                brief={brief}
                entityOptions={entityOptions}
                propertiesOf={propertiesOf}
                updateShot={updateShot}
                setDelta={setDelta}
              />
            </Box>
            <ContinuityBrief brief={brief} cast={cast} leaveReason={leaveReason} onOpenShotState={onOpenShotState} />
          </Stack>
        ) : (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">{scenarioTexts.registry.selectShot}</Typography>
          </Paper>
        )}
      </Box>
    </>
  );
}
