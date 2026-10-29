import { useEffect, useState, type ReactElement } from 'react';
import { Box, Chip, Paper, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import type { ScenesFile, ShotProductionState } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';
import { useApp } from '../../../state';
import { SHOT_STATE_LABELS } from '../../../components/shotState';

/** Цвета частей чередуются по порядку: соседние части всегда различаются, а цвета берутся из темы и работают в обеих темах. */
const PART_COLORS = ['primary', 'info', 'success', 'warning', 'secondary'] as const;
type Mode = 'parts' | 'status';

/** Токен темы вида «success.main» или «grey.400» в цвет: по нему подбирается читаемый текст номера плана. */
function themeColor(theme: Theme, token: string): string {
  const [group, shade] = token.split('.');
  const palette = theme.palette as unknown as Record<string, Record<string, string>>;
  return palette[group]?.[shade] ?? theme.palette.grey[500];
}

/** Отображает части песни и планы на общей монтажной шкале; планы окрашиваются по частям или по статусу производства. */
export function SceneTimeline({
  scenes,
  duration,
  selected,
  onSelect
}: {
  scenes: ScenesFile;
  duration: number;
  selected: string | null;
  onSelect(id: string): void;
}): ReactElement {
  const theme = useTheme();
  const { state } = useApp();
  const project = state?.current ?? '';
  const [mode, setMode] = useState<Mode>('parts');
  const [states, setStates] = useState<Record<string, ShotProductionState> | null>(null);

  // Статус считает главный процесс по сохранённому реестру; после сохранения оболочка обновляет state, и статусы перечитываются.
  useEffect(() => {
    if (mode !== 'status' || !project) return;
    let cancelled = false;
    window.api.production
      .view(project)
      .then((view) => {
        if (!cancelled) setStates(Object.fromEntries(view.shots.map((shot) => [shot.id, shot.state])));
      })
      .catch(() => {
        if (!cancelled) setStates({});
      });
    return () => {
      cancelled = true;
    };
  }, [mode, project, state]);

  const total = Math.max(duration * FPS, scenes.scenes.at(-1)?.end_frame_exclusive ?? 1);
  const seqIndex = new Map(scenes.sequences.map((s, i) => [s.id, i]));
  const partColor = (sequence: string): string => theme.palette[PART_COLORS[(seqIndex.get(sequence) ?? 0) % PART_COLORS.length]].main;
  const shotState = (id: string): ShotProductionState => states?.[id] ?? 'planned';
  const shotColor = (id: string, sequence: string): string =>
    mode === 'status' ? themeColor(theme, SHOT_STATE_LABELS[shotState(id)].bar) : partColor(sequence);
  const counts = new Map<ShotProductionState, number>();
  if (mode === 'status') for (const shot of scenes.scenes) counts.set(shotState(shot.id), (counts.get(shotState(shot.id)) ?? 0) + 1);

  return (
    <Paper variant="outlined" sx={{ p: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.75 }}>
        <Typography variant="caption" color="text.secondary">
          Цвет планов:
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_event, next: Mode | null) => next && setMode(next)}
          aria-label="Цвет планов на шкале"
        >
          <ToggleButton value="parts" sx={{ py: 0.25, px: 1 }}>
            По частям
          </ToggleButton>
          <ToggleButton value="status" sx={{ py: 0.25, px: 1 }}>
            По статусу
          </ToggleButton>
        </ToggleButtonGroup>
        {/* Легенда показывает только встречающиеся статусы с числом планов. */}
        {mode === 'status'
          ? (Object.keys(SHOT_STATE_LABELS) as ShotProductionState[])
              .filter((key) => counts.get(key))
              .map((key) => (
                <Chip
                  key={key}
                  size="small"
                  variant="outlined"
                  label={`${SHOT_STATE_LABELS[key].label}: ${counts.get(key)}`}
                  icon={<Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: SHOT_STATE_LABELS[key].bar, ml: '6px !important' }} />}
                />
              ))
          : null}
      </Box>
      <Box sx={{ display: 'flex', height: 18, mb: 0.5 }}>
        {scenes.sequences.map((seq) => {
          const members = scenes.scenes.filter((s) => s.sequence === seq.id);
          if (!members.length) return null;
          const start = Math.min(...members.map((m) => m.start_frame));
          const end = Math.max(...members.map((m) => m.end_frame_exclusive));
          const color = partColor(seq.id);
          return (
            <Tooltip key={seq.id} title={seq.title || seq.id}>
              <Box
                sx={{
                  width: `${((end - start) / total) * 100}%`,
                  // Полоса части светлая с цветной кромкой: подпись читается основным цветом текста в обеих темах.
                  bgcolor: alpha(color, theme.palette.mode === 'dark' ? 0.3 : 0.18),
                  borderLeft: 3,
                  borderColor: color,
                  color: 'text.primary',
                  px: 0.5,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  fontSize: 11,
                  lineHeight: '18px',
                  borderRadius: 0.5
                }}
              >
                {seq.title || seq.id}
              </Box>
            </Tooltip>
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', height: 34 }}>
        {scenes.scenes.map((s) => {
          const color = shotColor(s.id, s.sequence);
          const isSelected = s.id === selected;
          return (
            <Tooltip
              key={s.id}
              title={`${s.id} · ${formatClock(s.start_frame / FPS)}–${formatClock(s.end_frame_exclusive / FPS)}${mode === 'status' ? ` · ${SHOT_STATE_LABELS[shotState(s.id)].label}` : ''}`}
            >
              <Box
                onClick={() => onSelect(s.id)}
                sx={{
                  width: `${((s.end_frame_exclusive - s.start_frame) / total) * 100}%`,
                  bgcolor: color,
                  // Цвет номера подбирается под фон, поэтому номер читается и на светлых цветах.
                  color: theme.palette.getContrastText(color),
                  boxShadow: isSelected ? `inset 0 0 0 2px ${theme.palette.background.paper}` : undefined,
                  outline: isSelected ? '2px solid' : `1px solid ${theme.palette.divider}`,
                  outlineColor: isSelected ? 'text.primary' : undefined,
                  outlineOffset: isSelected ? -1 : 0,
                  fontWeight: isSelected ? 700 : 400,
                  cursor: 'pointer',
                  fontSize: 10,
                  px: 0.25,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  zIndex: isSelected ? 1 : 0
                }}
              >
                {s.id.replace(/^M/, '')}
              </Box>
            </Tooltip>
          );
        })}
      </Box>
    </Paper>
  );
}
