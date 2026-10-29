import type { OpenShotState } from '../types';
import type { ReactElement } from 'react';
import { TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { countLabel } from '@shared/plural';
import type { BriefEntity } from '../briefComparison';
import { BriefValueCell } from './BriefValueCell';

/** Строки одной сущности: заголовок с числом изменений и свойства; без изменений при фильтре строки свёрнуты. */
export function BriefEntityRows({
  entity,
  onlyChanges,
  currentShot,
  leaveReason,
  onOpenShotState
}: {
  entity: BriefEntity;
  onlyChanges: boolean;
  currentShot: string;
  leaveReason: string | null;
  onOpenShotState: OpenShotState;
}): ReactElement {
  const rows = onlyChanges ? entity.rows.filter((row) => row.change !== 'same') : entity.rows;
  const hidden = entity.rows.length - rows.length;
  return (
    <TableBody>
      <TableRow sx={{ bgcolor: 'action.hover' }}>
        <TableCell component="th" scope="colgroup" colSpan={3} sx={{ py: 0.75 }}>
          <Typography variant="body2" component="span" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
            {entity.name}
          </Typography>
          <Typography variant="caption" component="span" color="text.secondary" sx={{ ml: 1 }}>
            {entity.changes ? `изменений: ${entity.changes}` : 'без изменений за план'}
            {hidden ? ` · скрыто без изменений: ${countLabel(hidden, 'свойство', 'свойства', 'свойств')}` : ''}
          </Typography>
        </TableCell>
      </TableRow>
      {rows.map((row) => (
        <TableRow key={row.key}>
          <TableCell
            component="th"
            scope="row"
            title={row.label === row.key ? undefined : `Код свойства: ${row.key}`}
            sx={{ verticalAlign: 'top', overflowWrap: 'anywhere' }}
          >
            <Typography variant="body2" color="text.secondary">
              {row.label}
            </Typography>
          </TableCell>
          {(['before', 'after'] as const).map((side) => (
            <BriefValueCell
              key={side}
              cell={row[side]}
              change={row.change}
              side={side}
              entity={entity.id}
              entityName={entity.name}
              currentShot={currentShot}
              leaveReason={leaveReason}
              onOpenShotState={onOpenShotState}
            />
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}
