import { derivedShotTexts } from '@shared/texts/derived-shot';
import { shotPageRoute } from '../../../components/shotRoutes';
import { scenesTexts } from '@shared/texts/scenes';
import { commonTexts } from '@shared/texts/common';
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
import { ShotPageButton } from '../../../components/ShotPageButton';

/** Собирает подробности выбранной сцены и действия перехода к её постановке и производству. */
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
          {shot.animaticMedia ? (
            <Chip size="small" variant="outlined" label={scenesTexts.details.animaticMedia({ media: MEDIA_LABELS[shot.animaticMedia] })} />
          ) : null}
          {shot.derivedFrom ? (
            <Chip
              size="small"
              variant="outlined"
              label={derivedShotTexts.derivedFrom({ source: shot.derivedFrom })}
              title={derivedShotTexts.openBuilder({ shot: shot.id })}
              onClick={() => onNavigate(shotPageRoute('production', shot.id))}
            />
          ) : null}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {scenesTexts.details.timing({ start: formatClock(shot.start), end: formatClock(shot.end), frames: shot.frames, sequence: shot.sequenceTitle })}
          </Typography>
        </Box>
        <Typography variant="subtitle1" fontWeight={600}>
          {shot.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {shot.stageLabel}
          {shot.packagesCount > 1 ? scenesTexts.details.packageCount({ count: shot.packagesCount }) : ''}
        </Typography>
        <Divider />

        <ShotMedia shot={shot} />
        <ShotInputs shot={shot} />
        <ShotPrompt shot={shot} />
        <ShotStaging shot={shot} />

        <ShotSection title={scenesTexts.details.worldState}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
            <ShotStateBlock title={scenesTexts.details.firstFrame} data={shot.before} />
            <ShotStateBlock title={scenesTexts.details.lastFrame} data={shot.after} />
          </Box>
        </ShotSection>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <ShotPageButton page="production" shot={shot.id} />
          <ShotPageButton page="scenario" shot={shot.id} />
          <Button startIcon={<MovieIcon />} size="small" variant="outlined" onClick={() => onNavigate(`/project/animatic?shot=${shot.id}`)}>
            {scenesTexts.details.inAnimatic}
          </Button>
          {asset ? (
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(asset.dir)}>
              {scenesTexts.details.assetFolder}
            </Button>
          ) : shot.package ? (
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(shot.package!.dir)}>
              {scenesTexts.details.packageFolder}
            </Button>
          ) : null}
          <Button startIcon={<CloseIcon />} size="small" onClick={onClose}>
            {commonTexts.close}
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}
