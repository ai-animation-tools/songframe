/** Локальные модели монтажа используют рабочие операции и браузерные медиа; @link ../../../../docs/montage.md. */
import { useCallback, useState } from 'react';
import { Box, Button, Paper, Slider, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { MontageClip, MontageDraft, MontageScene, MontageSource, MontageView } from '@shared/montage';
import { MontageClipEditor } from '../pages/MontagePage/components/MontageClipEditor';
import { MontageRemoveDialog } from '../pages/MontagePage/components/MontageRemoveDialog';
import { MontagePreview } from '../pages/MontagePage/components/MontagePreview';
import { MontageSources } from '../pages/MontagePage/components/MontageSources';
import { MontageMaterialDialog } from '../pages/MontagePage/components/MontageMaterialDialog';
import { SourceMetadata } from '../pages/MontagePage/components/SourceMetadata';
import { clipLength, montageLength, projectMediaUrl, sourceClip } from '../pages/MontagePage/model';
import { STORY_IMAGE_PATH, STORY_TRACK_PATH } from './storybook';

export const MONTAGE_PROJECT = '/mock/Музыкальный клип/Материалы режиссёрской версии с очень длинным названием';
export const MONTAGE_SOURCE = 'assets/shots/M01/полный оригинал для проверки длинных путей/story-derived-source-150.mp4';
export const MONTAGE_LOCKED_REASON = 'Дождитесь завершения экспорта пробы.';
export const MONTAGE_SCENES: MontageScene[] = [
  { id: 'M01', title: 'Возвращение к воротам после долгой поездки по дачному товариществу', startFrame: 0, endFrame: 45 },
  { id: 'M02', title: 'Встреча у старого сарая', startFrame: 45, endFrame: 90 },
  { id: 'M03', title: 'Сцена без подготовленных материалов', startFrame: 90, endFrame: 120 }
];

export function montageSources(): MontageSource[] {
  return [
    {
      id: 'M01-original',
      scene: 'M01',
      title: MONTAGE_SCENES[0].title,
      label: 'Полный ролик · запас до и после принятого участка',
      path: MONTAGE_SOURCE,
      kind: 'video',
      frames: 150,
      original: true
    },
    {
      id: 'M01-accepted',
      scene: 'M01',
      title: MONTAGE_SCENES[0].title,
      label: 'Принятый монтаж сцены',
      path: 'assets/shots/M01/story-derived-preview-62.mp4',
      kind: 'video',
      frames: 62,
      original: false
    },
    {
      id: 'M01-card',
      scene: 'M01',
      title: MONTAGE_SCENES[0].title,
      label: 'Утверждённая опора K01',
      path: STORY_IMAGE_PATH,
      kind: 'card',
      frames: null,
      original: false
    },
    {
      id: 'M02-attempt',
      scene: 'M02',
      title: MONTAGE_SCENES[1].title,
      label: 'Новая генерация · результат ещё не принят',
      path: 'plan/batches/M02-attempt/story-derived-source-150.mp4?scene=M02',
      kind: 'video',
      frames: 150,
      original: false,
      attempt: true
    }
  ];
}

export function montageDraft(): MontageDraft {
  return {
    schema_version: 1,
    name: 'Проверка соседнего стыка',
    audio: { path: STORY_TRACK_PATH, start_frame: 0, end_frame_exclusive: 90 },
    clips: [
      { id: 'M01', scene: 'M01', path: MONTAGE_SOURCE, kind: 'video', source_start_frame: 15, source_end_frame_exclusive: 60, source_frames: 150 },
      { id: 'M02', scene: 'M02', path: montageSources()[3].path, kind: 'video', source_start_frame: 30, source_end_frame_exclusive: 75, source_frames: 150 }
    ],
    base_scenes_sha256: 'demo-scenes',
    base_manifest_sha256: { M01: 'demo-M01', M02: 'demo-M02' }
  };
}

export function montageView(): MontageView {
  return {
    scenarioStatus: 'ready',
    trackPath: STORY_TRACK_PATH,
    trackSha256: 'demo-track',
    duration: 5,
    lyricLines: [],
    lyricProblem: null,
    scenes: MONTAGE_SCENES,
    sources: montageSources(),
    scenesSha256: 'demo-scenes',
    manifestSha256: { M01: 'demo-M01', M02: 'demo-M02' },
    saved: [],
    problems: []
  };
}

/** Таблица показывает обе стороны стыка и исходники: проверка видит результат правки, а не число вызовов. */
function DraftState({ draft }: { draft: MontageDraft }) {
  return (
    <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Границы монтажной пробы">
        <TableHead>
          <TableRow>
            <TableCell>Сцена</TableCell>
            <TableCell>Начало</TableCell>
            <TableCell>Конец</TableCell>
            <TableCell>Длительность</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {draft.clips.map((clip) => (
            <TableRow key={clip.id} data-testid={`clip-state-${clip.scene}`}>
              <TableCell>{clip.scene}</TableCell>
              <TableCell>{clip.source_start_frame}</TableCell>
              <TableCell>{clip.source_end_frame_exclusive}</TableCell>
              <TableCell>{clipLength(clip)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography data-testid="montage-audio-range" variant="body2" sx={{ p: 1 }}>
        Музыка: {draft.audio.start_frame} — {draft.audio.end_frame_exclusive} кадров; длительность: {draft.audio.end_frame_exclusive - draft.audio.start_frame}{' '}
        кадров
      </Typography>
      <Typography data-testid="montage-length" variant="body2" sx={{ p: 1 }}>
        Длина видео: {montageLength(draft.clips)} кадров
      </Typography>
    </Paper>
  );
}

export interface MontageEditorStoryProps {
  card?: boolean;
  empty?: boolean;
  unknownMetadata?: boolean;
  locked?: boolean;
}

export function MontageEditorStory({ card = false, empty = false, unknownMetadata = false, locked = false }: MontageEditorStoryProps) {
  const makeDraft = (): MontageDraft => {
    const value = montageDraft();
    if (card)
      value.clips[0] = { ...value.clips[0], path: STORY_IMAGE_PATH, kind: 'card', source_start_frame: 0, source_end_frame_exclusive: 45, source_frames: null };
    if (unknownMetadata) value.clips[0].source_frames = null;
    return value;
  };
  const [draft, setDraft] = useState(makeDraft);
  const [removing, setRemoving] = useState(false);
  return (
    <Stack spacing={2}>
      <MontageClipEditor
        draft={draft}
        clip={empty ? undefined : draft.clips.find((clip) => clip.id === 'M01')}
        title={MONTAGE_SCENES[0].title}
        onChange={setDraft}
        onRequestRemove={() => setRemoving(true)}
        disabled={locked}
        disabledReason={MONTAGE_LOCKED_REASON}
      />
      <DraftState draft={draft} />
      <Typography data-testid="retained-materials" variant="caption" sx={{ overflowWrap: 'anywhere' }}>
        Исходные материалы сохранены: {card ? STORY_IMAGE_PATH : MONTAGE_SOURCE}; {montageSources()[3].path}
      </Typography>
      <Button
        onClick={() => {
          setDraft(makeDraft());
          setRemoving(false);
        }}
      >
        Сбросить модель
      </Button>
      <MontageRemoveDialog
        scene={removing ? 'M01' : undefined}
        onClose={() => setRemoving(false)}
        onConfirm={() => {
          setDraft((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== 'M01') }));
          setRemoving(false);
        }}
      />
    </Stack>
  );
}

export interface MontagePreviewStoryProps {
  noTrack?: boolean;
  missingVideo?: boolean;
  suspended?: boolean;
  card?: boolean;
}

export function MontagePreviewStory({ noTrack = false, missingVideo = false, suspended = false, card = false }: MontagePreviewStoryProps) {
  const [draft, setDraft] = useState(() => {
    const value = montageDraft();
    // Подготовленный ролик содержит ровно 150 кадров: длину читает настоящий video, без ffprobe.
    value.clips = value.clips.map((clip) => ({ ...clip, source_frames: null }));
    if (missingVideo) value.clips[0].path = 'assets/shots/M01/недоступный-оригинал.mp4';
    if (card) value.clips[0] = { ...value.clips[0], kind: 'card', path: STORY_IMAGE_PATH, source_start_frame: 0, source_end_frame_exclusive: 45 };
    return value;
  });
  const [frame, setFrame] = useState(0);
  const [seekVersion, setSeekVersion] = useState(0);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(30);
  const [trackFrames, setTrackFrames] = useState<number | null>(null);
  const metadata = useCallback(
    (path: string, frames: number) =>
      setDraft((current) =>
        current.clips.some((clip) => clip.path === path && clip.source_frames !== frames)
          ? { ...current, clips: current.clips.map((clip) => (clip.path === path ? { ...clip, source_frames: frames } : clip)) }
          : current
      ),
    []
  );
  return (
    <Stack spacing={2}>
      <MontagePreview
        project={MONTAGE_PROJECT}
        draft={draft}
        trackUrl={noTrack ? null : projectMediaUrl(MONTAGE_PROJECT, STORY_TRACK_PATH)}
        frame={frame}
        seekVersion={seekVersion}
        selectedClipId="M01"
        loop={loop}
        volume={volume}
        onPreferences={(nextLoop, nextVolume) => {
          setLoop(nextLoop);
          setVolume(nextVolume);
        }}
        onFrame={setFrame}
        onMetadata={metadata}
        onTrackFrames={setTrackFrames}
        suspended={suspended}
        suspendedReason={MONTAGE_LOCKED_REASON}
      />
      <Box sx={{ px: 1 }}>
        <Slider
          aria-label="Позиция демонстрации"
          value={frame}
          max={89}
          disabled={suspended}
          onChange={(_, value) => {
            setFrame(value as number);
            setSeekVersion((version) => version + 1);
          }}
        />
      </Box>
      <Typography data-testid="preview-state" variant="body2">
        Кадр пробы: {frame}; метаданные M01: {draft.clips[0].source_frames ?? 'ожидание'}; длина песни: {trackFrames ?? 'ожидание'}; громкость: {volume}%;
        повтор: {loop ? 'включён' : 'выключен'}.
      </Typography>
    </Stack>
  );
}

export interface MontageSourcesStoryProps {
  unknownMetadata?: boolean;
  missing?: boolean;
  initiallyEmpty?: boolean;
}

export function MontageSourcesStory({ unknownMetadata = false, missing = false, initiallyEmpty = false }: MontageSourcesStoryProps) {
  const [sources, setSources] = useState(() =>
    montageSources().map((source) =>
      missing && source.id === 'M01-original'
        ? { ...source, path: 'assets/shots/M01/потерянный-original.mp4' }
        : unknownMetadata && source.kind === 'video'
          ? { ...source, frames: null }
          : source
    )
  );
  const [draft, setDraft] = useState(() => {
    const value = montageDraft();
    if (initiallyEmpty) value.clips = [];
    return value;
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const metadata = useCallback(
    (path: string, frames: number) => setSources((current) => current.map((source) => (source.path === path ? { ...source, frames } : source))),
    []
  );
  const position = sources.findIndex((source) => source.id === preview);
  const source = sources[position];
  const add = (id: string): void => {
    const item = sources.find((candidate) => candidate.id === id);
    if (!item) return;
    setDraft((current) => {
      const existing = current.clips.find((clip) => clip.scene === item.scene);
      const canonical = MONTAGE_SCENES.find((scene) => scene.id === item.scene);
      const clip: MontageClip = sourceClip(item, existing ? clipLength(existing) : canonical ? canonical.endFrame - canonical.startFrame : 1);
      // Как в useMontage.addSource, первый материал выбирает музыкальный участок своей сцены.
      // Следующие добавления и замены сохраняют выбранную музыку и id существующего фрагмента.
      const audio = current.clips.length
        ? current.audio
        : { ...current.audio, start_frame: canonical?.startFrame ?? 0, end_frame_exclusive: canonical?.endFrame ?? clipLength(clip) };
      return {
        ...current,
        audio,
        clips: existing
          ? current.clips.map((currentClip) => (currentClip.id === existing.id ? { ...clip, id: existing.id } : currentClip))
          : [...current.clips, clip]
      };
    });
    setSelected(item.scene);
  };
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ height: 620, display: 'flex', minWidth: 0 }}>
        <MontageSources
          project={MONTAGE_PROJECT}
          sources={sources}
          scenes={MONTAGE_SCENES}
          clips={draft.clips}
          selectedClipId={selected}
          onSelectClip={setSelected}
          onPreview={(item) => setPreview(item.id)}
          onAdd={add}
        />
      </Paper>
      <DraftState draft={draft} />
      <Typography data-testid="source-selection" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        Выбрано: {selected ?? 'нет'}; M01: {draft.clips.find((clip) => clip.scene === 'M01')?.path ?? 'не добавлена'}; исходные материалы:{' '}
        {sources.map((item) => item.id).join(', ')}.
      </Typography>
      <SourceMetadata project={MONTAGE_PROJECT} sources={sources} onMetadata={metadata} />
      {source ? (
        <MontageMaterialDialog
          project={MONTAGE_PROJECT}
          source={source}
          position={position}
          total={sources.length}
          onPrevious={position > 0 ? () => setPreview(sources[position - 1].id) : undefined}
          onNext={position < sources.length - 1 ? () => setPreview(sources[position + 1].id) : undefined}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </Stack>
  );
}
