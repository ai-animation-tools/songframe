/** Производный план собирается из материала другого плана: строка с переходом к плану-источнику. */
import type { ReactElement } from 'react';
import { Alert, Link } from '@mui/material';
import { Link as RouterLink, useInRouterContext } from 'react-router-dom';
import { shotPageRoute } from '../../../components/shotRoutes';

export function DerivedShotNotice({ source }: { source: string }): ReactElement {
  // Вне маршрутизатора (изолированный тест блока) переходить некуда: код плана остаётся текстом.
  const routed = useInRouterContext();
  return (
    <Alert severity="info">
      План собирается из материала{' '}
      {routed ? (
        <Link component={RouterLink} to={shotPageRoute('production', source)} color="inherit" underline="always">
          {source}
        </Link>
      ) : (
        source
      )}
      . Описание, опоры и генерация для него не нужны; сборка производного комплекта в приложении пока не поддерживается.
    </Alert>
  );
}
