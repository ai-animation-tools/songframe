/** Сохранённый возврат объясняет следующий шаг, не выдавая ответ пакета за состояние процесса агента. */
import type { ReactElement } from 'react';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Alert, Box, Button, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { isExternalPackage } from '../decisions';

export function PackageRevisionNotice({ pkg, onOpenRevision }: { pkg: PackageView; onOpenRevision?(): void }): ReactElement | null {
  // Новый вопрос заменяет прежнее замечание: материалы следующего согласования уже требуют своего ответа.
  if (pkg.pendingDecision || pkg.decision?.verdict !== 'revise') return null;
  const external = isExternalPackage(pkg);
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <Typography fontWeight={600} gutterBottom>
        {external ? 'Замечание сохранено для внешнего агента' : 'Пакет возвращён с замечанием'}
      </Typography>
      {pkg.decision.note ? (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
          {pkg.decision.note}
        </Typography>
      ) : null}
      <Typography variant="body2">
        {external
          ? 'Приложение записало ответ. Внешний агент продолжит доработку, когда прочитает замечание. Если агент остановлен, возобновите его во внешнем чате; приложение не запускает новый процесс.'
          : 'Возврат с замечанием не запускает агента автоматически. Запуск и результат доработки — в блоке «Подготовка плана». Нажмите там «Запустить доработку с агентом», если ещё не запускали её.'}
      </Typography>
      {!external && onOpenRevision ? (
        <Box sx={{ mt: 1 }}>
          <Button size="small" variant="outlined" startIcon={<ArrowForwardIcon />} onClick={onOpenRevision}>
            Перейти к доработке
          </Button>
        </Box>
      ) : null}
    </Alert>
  );
}
