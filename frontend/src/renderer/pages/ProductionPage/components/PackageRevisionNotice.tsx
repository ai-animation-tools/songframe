import { productionTexts } from '@shared/texts/production';
/** Сохранённый возврат объясняет следующий шаг, не выдавая ответ пакета за состояние процесса агента. */
import type { ReactElement } from 'react';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Alert, Box, Button, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { LinkedText } from '../../../components/LinkedText';

export function PackageRevisionNotice({
  pkg,
  frameRunning = false,
  onOpenRevision
}: {
  pkg: PackageView;
  /** Опора этой попытки уже создаётся заново (задание агента или запрос изображения): совет создать её не нужен. */
  frameRunning?: boolean;
  /** Перейти к доработке; focusNote — сразу к полю замечания. */
  onOpenRevision?(focusNote?: boolean): void;
}): ReactElement | null {
  // Новый вопрос заменяет прежнее замечание: материалы следующего согласования уже требуют своего ответа.
  if (pkg.pendingDecision || pkg.decision?.verdict !== 'revise') return null;
  // Возврат опоры: замечание уже в списке замечаний к опорам, следующий шаг — создать опору заново, а не доработка агентом.
  // Пока опора создаётся, этот шаг уже сделан: подсказка вернётся, только если задание не даст нового вопроса.
  if (pkg.decision.stage === 'keyframes_review' && frameRunning) return null;
  if (pkg.decision.stage === 'keyframes_review')
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography fontWeight={600} gutterBottom>
          {productionTexts.packageRevisionNotice.frameTitle}
        </Typography>
        {pkg.decision.note ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
            {pkg.decision.note}
          </Typography>
        ) : null}
        <Typography variant="body2">
          <LinkedText text={productionTexts.packageRevisionNotice.frameDescription} />
        </Typography>
        {onOpenRevision ? (
          <Box sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" startIcon={<ArrowForwardIcon />} onClick={() => onOpenRevision(false)}>
              {productionTexts.packageRevisionNotice.openPreparation}
            </Button>
          </Box>
        ) : null}
      </Alert>
    );
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <Typography fontWeight={600} gutterBottom>
        {productionTexts.packageRevisionNotice.title}
      </Typography>
      {pkg.decision.note ? (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
          {pkg.decision.note}
        </Typography>
      ) : null}
      <Typography variant="body2">
        <LinkedText text={productionTexts.packageRevisionNotice.description} />
      </Typography>
      {onOpenRevision ? (
        <Box sx={{ mt: 1 }}>
          <Button size="small" variant="outlined" startIcon={<ArrowForwardIcon />} onClick={() => onOpenRevision()}>
            {productionTexts.packageRevisionNotice.openRevision}
          </Button>
        </Box>
      ) : null}
    </Alert>
  );
}
