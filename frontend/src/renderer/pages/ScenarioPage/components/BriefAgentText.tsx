import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/**
 * Свёрнутые абзацы врезки в том виде, в каком приложение вкладывает их в промпт опор. Раздел оформлен так же,
 * как соседний раздел «Вне плана» во врезке: Accordion с тем же видом заголовка.
 */
export function BriefAgentText({ before, after }: { before: string; after: string }): ReactElement {
  return (
    <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ '&::before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">{scenarioTexts.brief.agentText}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0, minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
          {scenarioTexts.brief.agentTextHint}
        </Typography>
        {[before, after].map((paragraph, index) => (
          <Typography key={index} variant="body2" sx={{ overflowWrap: 'anywhere', mt: index ? 1 : 0 }}>
            {paragraph}
          </Typography>
        ))}
      </AccordionDetails>
    </Accordion>
  );
}
