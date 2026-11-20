import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useRef, type ReactElement } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import type { CastFile, CastProperty, LyricsLine, ScenesFile, TimingLine } from '@shared/types';
import { SCENE_PROBLEMS_ID, type EntityOption, type OpenShotState, type ScenarioBrief, type ShotReveal } from '../types';
import { useSceneDraft } from '../useSceneDraft';
import { useSchemesOnDemand } from '../useSchemesOnDemand';
import { SceneTimeline } from './SceneTimeline';
import { SceneList } from './SceneList';
import { useShotStates } from '../useShotStates';
import { SceneShotEditor } from './SceneShotEditor';
import { SceneStateEditor } from './SceneStateEditor';
import { ContinuityBrief } from './ContinuityBrief';
import { coveredArea, revealAnchor } from '../../../hooks/useAnchorTarget';

/** Собирает реестр из списка, шкалы и редакторов выбранного плана. */
export function SceneRegistry({
  resetKey,
  scenes,
  setScenes,
  stickyTop,
  selected,
  setSelected,
  revealShot,
  onRevealed,
  onOpenShotState,
  leaveReason,
  problems,
  duration,
  brief,
  cast,
  entityOptions,
  referenceOptions,
  propertiesOf,
  notify,
  acceptedShots = [],
  shotNotice = null,
  lines = [],
  lyrics = [],
  maxVideoSeconds = null
}: {
  resetKey?: object | null;
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
  problems: string[];
  duration: number;
  brief: ScenarioBrief;
  cast: CastFile | null;
  entityOptions: EntityOption[];
  referenceOptions: EntityOption[];
  propertiesOf(entity: string): CastProperty[];
  notify(message: string, severity: 'warning'): void;
  /** Планы с принятым видео: их постановка и состояние закрыты для правки. */
  acceptedShots?: string[];
  /** Сообщение над карточкой выбранного плана, например о его проблемах в отчёте проверки. */
  shotNotice?: ReactNode;
  /** Разметка и текст песни: деление плана идёт по началу строки. */
  lines?: readonly TimingLine[];
  lyrics?: readonly LyricsLine[];
  /** Предел одного запроса видео у провайдера проекта: предупреждение при объединении. */
  maxVideoSeconds?: number | null;
}): ReactElement {
  const { shot, shotIndex, updateShot, setBoundary, split, merge, setDelta } = useSceneDraft(scenes, selected, setScenes, setSelected, notify);
  const locked = !!shot && acceptedShots.includes(shot.id);
  const states = useShotStates();
  const schemes = useSchemesOnDemand();
  // Граница и слияние меняют и следующий план, поэтому его принятие тоже закрывает эти правки.
  const nextId = shotIndex >= 0 ? scenes.scenes[shotIndex + 1]?.id : undefined;
  const nextLocked = nextId && acceptedShots.includes(nextId) ? nextId : null;
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
      <SceneTimeline scenes={scenes} duration={duration} selected={selected} onSelect={setSelected} states={states} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '300px minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        {/* В двух колонках список закреплён под панелью страницы и прокручивается сам, пока редактор плана листается. */}
        <Box ref={listRef} sx={{ minWidth: 0, position: { lg: 'sticky' }, top: { lg: stickyTop } }}>
          <SceneList
            scenes={scenes}
            selected={selected}
            onSelect={setSelected}
            states={states}
            maxHeight={{ xs: '50vh', lg: `calc(100vh - ${stickyTop + 16}px)` }}
          />
        </Box>
        {shot ? (
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            {shotNotice}
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
                merge={merge}
                lines={lines}
                lyrics={lyrics}
                acceptedShots={acceptedShots}
                maxVideoSeconds={maxVideoSeconds}
                locked={locked}
                nextLocked={nextLocked}
                cast={cast}
                schemes={schemes}
              />
            </Box>
            <Box ref={stateRef} sx={{ minWidth: 0 }}>
              <SceneStateEditor
                resetKey={resetKey}
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
                locked={locked}
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
