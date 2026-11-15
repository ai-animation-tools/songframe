/** Проблемы сборки аниматика: короткий список целиком, длинный — сводкой со свёрнутыми подробностями. */
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, AlertTitle, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { animaticTexts } from '@shared/texts/animatic';
import { LinkedText } from '../../../components/LinkedText';

/**
 * Сколько причин показывается списком сразу. Изменённые входы Go перечисляет по одному файлу:
 * после пересоздания карточек это десятки строк, и сводка с подробностями по запросу читается лучше.
 */
export const ANIMATIC_PROBLEMS_INLINE = 3;

interface AnimaticProblemsProps {
  problems: string[];
  /** Есть собранный аниматик: проблемы означают устаревшую сборку, а не предусловие первой. */
  built: boolean;
}

function ProblemList({ problems }: { problems: string[] }): ReactElement {
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {problems.map((problem) => (
        <li key={problem}>
          <LinkedText text={problem} />
        </li>
      ))}
    </ul>
  );
}

export function AnimaticProblems({ problems, built }: AnimaticProblemsProps): ReactElement | null {
  if (!problems.length) return null;
  if (!built || problems.length <= ANIMATIC_PROBLEMS_INLINE)
    return (
      <Alert severity={built ? 'warning' : 'info'}>
        <ProblemList problems={problems} />
      </Alert>
    );
  return (
    <Alert severity="warning" sx={{ '& .MuiAlert-message': { flex: 1, minWidth: 0 } }}>
      <AlertTitle>{animaticTexts.problems.staleTitle}</AlertTitle>
      <Typography variant="body2">{animaticTexts.problems.summary({ count: problems.length })}</Typography>
      <Accordion disableGutters elevation={0} sx={{ mt: 1, bgcolor: 'transparent', color: 'inherit', '&::before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
          <Typography variant="body2" fontWeight={500}>
            {animaticTexts.problems.details}
          </Typography>
        </AccordionSummary>
        {/* Длинный список прокручивается внутри: область получает фокус и имя, чтобы её листали с клавиатуры. */}
        <AccordionDetails tabIndex={0} aria-label={animaticTexts.problems.details} sx={{ px: 0, pt: 0, maxHeight: 320, overflow: 'auto' }}>
          <ProblemList problems={problems} />
        </AccordionDetails>
      </Accordion>
    </Alert>
  );
}
