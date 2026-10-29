/** Сохранённый возврат объясняет следующий шаг, не выдавая ответ пакета за состояние процесса агента. */
import type { ReactElement } from 'react';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Alert, Box, Button, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { LinkedText } from '../../../components/LinkedText';

export function PackageRevisionNotice({ pkg, onOpenRevision }: { pkg: PackageView; onOpenRevision?(focusNote?: boolean): void }): ReactElement | null {
  // Новый вопрос заменяет прежнее замечание: материалы следующего согласования уже требуют своего ответа.
  if (pkg.pendingDecision || pkg.decision?.verdict !== 'revise') return null;
  // Возврат опоры: замечание уже в списке замечаний к опорам, следующий шаг — создать опору заново, а не доработка агентом.
  if (pkg.decision.stage === 'keyframes_review')
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <Typography fontWeight={600} gutterBottom>
          Опора возвращена на доработку
        </Typography>
        {pkg.decision.note ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
            {pkg.decision.note}
          </Typography>
        ) : null}
        <Typography variant="body2">
          <LinkedText text="Замечание сохранено в списке «Замечания к опорам» ниже и будет передано агенту при создании опоры. Создайте её заново кнопкой «Создать …» в блоке «Подготовка плана». Доработка с агентом нужна, только если надо изменить само описание или промпты опор." />
        </Typography>
        {onOpenRevision ? (
          <Box sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" startIcon={<ArrowForwardIcon />} onClick={() => onOpenRevision(false)}>
              Перейти к подготовке плана
            </Button>
          </Box>
        ) : null}
      </Alert>
    );
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <Typography fontWeight={600} gutterBottom>
        Пакет возвращён с замечанием
      </Typography>
      {pkg.decision.note ? (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
          {pkg.decision.note}
        </Typography>
      ) : null}
      <Typography variant="body2">
        <LinkedText text="Возврат с замечанием не запускает агента автоматически. Запуск и результат доработки — в блоке «Подготовка плана». Нажмите там «Запустить доработку с агентом», если ещё не запускали её." />
      </Typography>
      {onOpenRevision ? (
        <Box sx={{ mt: 1 }}>
          <Button size="small" variant="outlined" startIcon={<ArrowForwardIcon />} onClick={() => onOpenRevision()}>
            Перейти к доработке
          </Button>
        </Box>
      ) : null}
    </Alert>
  );
}
