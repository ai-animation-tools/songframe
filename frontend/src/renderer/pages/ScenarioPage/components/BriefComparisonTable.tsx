import { scenarioTexts } from '@shared/texts/scenario';
import type { OpenShotState } from '../types';
import type { ReactElement } from 'react';
import { Box, Table, TableCell, TableHead, TableRow } from '@mui/material';
import type { BriefEntity } from '../briefComparison';
import { BriefEntityRows } from './BriefEntityRows';

/** Таблица врезки: свойства сущностей на первом и последнем кадре плана, как в diff — слева начало, справа итог. */
export function BriefComparisonTable({
  entities,
  shot,
  onlyChanges,
  leaveReason,
  onOpenShotState
}: {
  entities: BriefEntity[];
  /** План, для которого вычислена врезка. */
  shot: string;
  onlyChanges: boolean;
  leaveReason: string | null;
  onOpenShotState: OpenShotState;
}): ReactElement {
  return (
    // Узкая рабочая область прокручивает таблицу локально, а не всю страницу.
    <Box sx={{ overflowX: 'auto', minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 560, '& tbody:last-of-type tr:last-of-type > *': { borderBottom: 0 } }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: '24%' }}>{scenarioTexts.fields.property}</TableCell>
            <TableCell>{scenarioTexts.brief.firstShotFrame({ shot })}</TableCell>
            <TableCell>{scenarioTexts.brief.lastShotFrame({ shot })}</TableCell>
          </TableRow>
        </TableHead>
        {entities.map((entity) => (
          <BriefEntityRows
            key={entity.id}
            entity={entity}
            onlyChanges={onlyChanges}
            currentShot={shot}
            leaveReason={leaveReason}
            onOpenShotState={onOpenShotState}
          />
        ))}
      </Table>
    </Box>
  );
}
