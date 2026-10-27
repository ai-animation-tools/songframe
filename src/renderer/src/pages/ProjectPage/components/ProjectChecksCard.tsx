/** Признаки готовности исходников, постановки, сцен и актуального аниматика. */

import type { ReactElement } from 'react';
import { Chip, List, ListItem, ListItemIcon, ListItemText, Paper, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import type { ProjectStatus } from '@shared/types';

export function ProjectChecksCard({ status }: { status: ProjectStatus }): ReactElement {
  const checks = status.checks;
  const rows: { label: string; ok: boolean; note?: string }[] = [
    { label: 'plan/project.json', ok: checks.marker },
    { label: 'Исходники: трек, текст, идея (source/manifest.json)', ok: checks.sources },
    { label: 'Разметка трека (plan/audio/timing.json)', ok: checks.timing },
    { label: 'Кастинг (plan/cast.json)', ok: checks.cast },
    { label: 'Трактовка (plan/treatment.json)', ok: checks.treatment },
    { label: 'Реестр сцен (plan/scenes.json)', ok: checks.scenes, note: checks.scenes ? `${checks.shotsTotal} планов` : undefined },
    {
      label: 'Принятые сцены (assets/shots)',
      ok: checks.shotsTotal > 0 && checks.shotsDone === checks.shotsTotal,
      note: `${checks.shotsDone} из ${checks.shotsTotal}`
    },
    {
      label: 'Аниматик собран по текущему реестру',
      ok: checks.animaticBuilt && checks.animaticFresh,
      note: checks.animaticBuilt && !checks.animaticFresh ? 'устарел' : undefined
    },
    {
      label: 'Аниматик принят',
      ok: checks.animaticApproved && checks.animaticFresh,
      note: checks.animaticApproved && !checks.animaticFresh ? 'принято прежнее состояние' : undefined
    }
  ];

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Признаки состояния
      </Typography>
      <List dense disablePadding>
        {rows.map((row) => (
          <ListItem key={row.label} disableGutters>
            <ListItemIcon sx={{ minWidth: 32 }}>
              {row.ok ? <CheckCircleIcon color="success" fontSize="small" /> : <RadioButtonUncheckedIcon color="disabled" fontSize="small" />}
            </ListItemIcon>
            <ListItemText primary={row.label} />
            {row.note ? <Chip size="small" variant="outlined" label={row.note} /> : null}
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}
