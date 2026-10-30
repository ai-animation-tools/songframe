import { projectTexts } from '@shared/texts/project';
/** Признаки готовности исходников, постановки, сцен и актуального аниматика. */

import type { ReactElement } from 'react';
import { Chip, List, ListItem, ListItemIcon, ListItemText, Paper, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import type { ProjectStatus } from '@shared/types';

export function ProjectChecksCard({ status }: { status: ProjectStatus }): ReactElement {
  const checks = status.checks;
  const rows: { label: string; ok: boolean; note?: string }[] = [
    { label: projectTexts.settings.filename, ok: checks.marker },
    { label: projectTexts.checks.sources, ok: checks.sources },
    { label: projectTexts.checks.timing, ok: checks.timing },
    { label: projectTexts.checks.cast, ok: checks.cast },
    { label: projectTexts.checks.treatment, ok: checks.treatment },
    { label: projectTexts.checks.scenes, ok: checks.scenes, note: checks.scenes ? projectTexts.checks.shots(checks.shotsTotal) : undefined },
    {
      label: projectTexts.checks.accepted,
      ok: checks.shotsTotal > 0 && checks.shotsDone === checks.shotsTotal,
      note: projectTexts.checks.acceptedCount({ done: checks.shotsDone, total: checks.shotsTotal })
    },
    {
      label: projectTexts.checks.animaticBuilt,
      ok: checks.animaticBuilt && checks.animaticFresh,
      note: checks.animaticBuilt && !checks.animaticFresh ? projectTexts.checks.stale : undefined
    },
    {
      label: projectTexts.checks.animaticApproved,
      ok: checks.animaticApproved && checks.animaticFresh,
      note: checks.animaticApproved && !checks.animaticFresh ? projectTexts.checks.previousApproved : undefined
    }
  ];

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {projectTexts.checks.title}
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
