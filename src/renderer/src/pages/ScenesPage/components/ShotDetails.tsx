import BuildIcon from '@mui/icons-material/Build';
import MovieIcon from '@mui/icons-material/Movie';
import CloseIcon from '@mui/icons-material/Close';
import type { ReactElement } from 'react';
import { Box, Button, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type { DashboardShot } from '@shared/types';
import { formatClock } from '../../../format';
import { MEDIA_LABELS, STATE_LABELS } from '../types';
import { ShotInputs } from './ShotInputs';
import { ShotMedia } from './ShotMedia';
import { ShotPrompt } from './ShotPrompt';
import { ShotSection } from './ShotSection';
import { ShotStaging } from './ShotStaging';
import { ShotStateBlock } from './ShotStateBlock';
import { countLabel } from '@shared/plural';

/** Собирает подробности выбранной сцены и действия перехода к её производству. */
export function ShotDetails({
  shot,
  onOpen,
  onNavigate,
  onClose
}: {
  shot: DashboardShot;
  onOpen(path: string): void;
  onNavigate(to: string): void;
  onClose(): void;
}): ReactElement {
  const asset = shot.asset;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>
            {shot.id}
          </Typography>
          <Chip size="small" color={STATE_LABELS[shot.state].color} label={STATE_LABELS[shot.state].label} />
          {shot.animaticMedia ? <Chip size="small" variant="outlined" label={`в аниматике: ${MEDIA_LABELS[shot.animaticMedia]}`} /> : null}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {formatClock(shot.start)}–{formatClock(shot.end)} · {countLabel(shot.frames, 'кадр', 'кадра', 'кадров')} · {shot.sequenceTitle}
          </Typography>
        </Box>
        <Typography variant="subtitle1" fontWeight={600}>
          {shot.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {shot.stageLabel}
          {shot.packagesCount > 1 ? ` · пакетов: ${shot.packagesCount}` : ''}
        </Typography>
        <Divider />

        <ShotMedia shot={shot} />
        <ShotInputs shot={shot} />
        <ShotPrompt shot={shot} />
        <ShotStaging shot={shot} />

        <ShotSection title="Состояние героев и мира">
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
            <ShotStateBlock title="На первый кадр" data={shot.before} />
            <ShotStateBlock title="На последний кадр" data={shot.after} />
          </Box>
        </ShotSection>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button startIcon={<BuildIcon />} size="small" variant="outlined" onClick={() => onNavigate(`/project/production?shot=${shot.id}`)}>
            В производстве
          </Button>
          <Button startIcon={<MovieIcon />} size="small" variant="outlined" onClick={() => onNavigate(`/project/animatic?shot=${shot.id}`)}>
            В аниматике
          </Button>
          {asset ? (
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(asset.dir)}>
              Папка комплекта
            </Button>
          ) : shot.package ? (
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(shot.package!.dir)}>
              Папка пакета
            </Button>
          ) : null}
          <Button startIcon={<CloseIcon />} size="small" onClick={onClose}>
            Закрыть
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
