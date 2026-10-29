import type { OpenShotState } from '../types';
import { type ReactElement, useMemo, useState } from 'react';
import { Box, Chip, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import type { CastFile } from '@shared/types';
import type { ScenarioBrief } from '../types';
import { compareBrief, totalChanges } from '../briefComparison';
import { BriefAgentText } from './BriefAgentText';
import { BriefChecklist } from './BriefChecklist';
import { BriefComparisonTable } from './BriefComparisonTable';

/** Вычисленная врезка непрерывности плана: что меняется от первого кадра к последнему и где задано каждое значение. */
export function ContinuityBrief({
  brief,
  cast,
  leaveReason,
  onOpenShotState
}: {
  brief: ScenarioBrief;
  cast: CastFile | null;
  /** Причина, по которой уход на «Кастинг» сейчас потеряет правки. */
  leaveReason: string | null;
  onOpenShotState: OpenShotState;
}): ReactElement {
  const [onlyChanges, setOnlyChanges] = useState(false);
  const entities = useMemo(() => (brief ? compareBrief(brief.before, brief.after, cast) : []), [brief, cast]);
  const changes = totalChanges(entities);

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Врезка непрерывности
        </Typography>
        {brief && entities.length ? (
          <Chip
            size="small"
            variant="outlined"
            color={changes ? 'warning' : 'default'}
            label={changes ? `Изменений за план: ${changes}` : 'Без изменений за план'}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        {brief && entities.length ? (
          <FormControlLabel
            control={<Switch size="small" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />}
            label="Только изменения за план"
            slotProps={{ typography: { variant: 'body2' } }}
            sx={{ mr: 0 }}
          />
        ) : null}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Складывается из начального состояния сущностей в кастинге и изменений «Первый кадр (before)» и «Итог плана (after)» в блоке «Состояние героев и мира»
        этого и предыдущих планов; приложение само передаёт её агенту для опор и видеопромпта. Чтобы исправить или сократить значение, нажмите его источник.
      </Typography>
      {brief ? (
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>
          {entities.length ? (
            <BriefComparisonTable
              entities={entities}
              shot={brief.before.shot}
              onlyChanges={onlyChanges}
              leaveReason={leaveReason}
              onOpenShotState={onOpenShotState}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              Состояние не задано: в кастинге нет начального состояния, а в планах нет изменений.
            </Typography>
          )}
          <BriefChecklist before={brief.before.checklist} after={brief.after.checklist} />
          {entities.length ? <BriefAgentText before={brief.before.paragraph} after={brief.after.paragraph} /> : null}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Врезка появится, когда реестр пройдёт проверку.
        </Typography>
      )}
    </Paper>
  );
}
