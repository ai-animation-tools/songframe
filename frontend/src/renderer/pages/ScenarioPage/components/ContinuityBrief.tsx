import { scenarioTexts } from '@shared/texts/scenario';
import type { OpenShotState } from '../types';
import { type ReactElement, useMemo, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
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
  const all = useMemo(() => (brief ? compareBrief(brief.before, brief.after, cast) : []), [brief, cast]);
  // Врезка агента построена по сущностям плана; остальные сущности с состоянием показываются отдельно и свёрнуто.
  const { entities, outside } = useMemo(() => {
    const scope = new Set([...(brief?.before.scope ?? []), ...(brief?.after.scope ?? [])]);
    return { entities: all.filter((entity) => scope.has(entity.id)), outside: all.filter((entity) => !scope.has(entity.id)) };
  }, [all, brief]);
  const changes = totalChanges(entities);

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          {scenarioTexts.brief.title}
        </Typography>
        {brief && entities.length ? (
          <Chip
            size="small"
            variant="outlined"
            color={changes ? 'warning' : 'default'}
            label={changes ? scenarioTexts.brief.changes({ count: changes }) : scenarioTexts.brief.noChanges}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        {brief && all.length ? (
          <FormControlLabel
            control={<Switch size="small" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />}
            label={scenarioTexts.brief.onlyChanges}
            slotProps={{ typography: { variant: 'body2' } }}
            sx={{ mr: 0 }}
          />
        ) : null}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {scenarioTexts.brief.description}
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
              {scenarioTexts.brief.stateMissing}
            </Typography>
          )}
          {outside.length ? (
            <Accordion disableGutters variant="outlined" sx={{ '&::before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle2">{scenarioTexts.brief.outsidePlan({ count: outside.length })}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {scenarioTexts.brief.outsidePlanHint}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <BriefComparisonTable
                  entities={outside}
                  shot={brief.before.shot}
                  onlyChanges={onlyChanges}
                  leaveReason={leaveReason}
                  onOpenShotState={onOpenShotState}
                />
              </AccordionDetails>
            </Accordion>
          ) : null}
          <BriefChecklist before={brief.before.checklist} after={brief.after.checklist} />
          {entities.length ? <BriefAgentText before={brief.before.paragraph} after={brief.after.paragraph} /> : null}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.brief.availableAfterValidation}
        </Typography>
      )}
    </Paper>
  );
}
