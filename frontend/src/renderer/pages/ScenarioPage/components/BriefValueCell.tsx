import { scenarioTexts } from '@shared/texts/scenario';
import type { OpenShotState } from '../types';
import type { ReactElement } from 'react';
import { Box, TableCell, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import ChangeCircleOutlinedIcon from '@mui/icons-material/ChangeCircleOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import type { BriefChange, BriefCell } from '../briefComparison';
import { BriefSourceLink } from './BriefSourceLink';

// Отличие за план показывается в ячейке последнего кадра: цвет, значок и подпись, чтобы читалось и без цвета.
const MARKS: Record<Exclude<BriefChange, 'same'>, { label: string; color: 'warning' | 'success' | 'error'; icon: ReactElement }> = {
  changed: { label: scenarioTexts.comparison.changed, color: 'warning', icon: <ChangeCircleOutlinedIcon fontSize="inherit" color="warning" /> },
  added: { label: scenarioTexts.comparison.added, color: 'success', icon: <AddCircleOutlineIcon fontSize="inherit" color="success" /> },
  removed: { label: scenarioTexts.comparison.removed, color: 'error', icon: <RemoveCircleOutlineIcon fontSize="inherit" color="error" /> }
};

/** Значение свойства на одной границе плана с источником; ячейка последнего кадра отмечает отличие от первого. */
export function BriefValueCell({
  cell,
  change,
  side,
  entity,
  entityName,
  currentShot,
  leaveReason,
  onOpenShotState
}: {
  cell: BriefCell | null;
  change: BriefChange;
  side: 'before' | 'after';
  entity: string;
  entityName: string;
  currentShot: string;
  leaveReason: string | null;
  onOpenShotState: OpenShotState;
}): ReactElement {
  const mark = side === 'after' && change !== 'same' ? MARKS[change] : null;
  return (
    <TableCell
      sx={{
        verticalAlign: 'top',
        overflowWrap: 'anywhere',
        ...(mark
          ? {
              bgcolor: (theme) => alpha(theme.palette[mark.color].main, theme.palette.mode === 'dark' ? 0.16 : 0.1),
              boxShadow: (theme) => `inset 3px 0 0 ${theme.palette[mark.color].main}`
            }
          : {})
      }}
    >
      {cell ? (
        cell.value.trim() ? (
          <Typography variant="body2">{cell.value}</Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" fontStyle="italic">
            {scenarioTexts.brief.empty}
          </Typography>
        )
      ) : (
        <Typography variant="body2" color="text.disabled" aria-label={scenarioTexts.brief.unspecified}>
          {scenarioTexts.brief.unsetMark}
        </Typography>
      )}
      {mark || cell?.source ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mt: 0.25 }}>
          {mark ? (
            <Typography variant="caption" fontWeight={600} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, fontSize: 12 }}>
              {mark.icon}
              {mark.label}
            </Typography>
          ) : null}
          {cell?.source ? (
            <BriefSourceLink
              source={cell.source}
              entity={entity}
              entityName={entityName}
              currentShot={currentShot}
              leaveReason={leaveReason}
              onOpenShotState={onOpenShotState}
            />
          ) : null}
        </Box>
      ) : null}
    </TableCell>
  );
}
