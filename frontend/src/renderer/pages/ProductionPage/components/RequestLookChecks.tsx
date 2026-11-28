/**
 * Итог бесплатной сверки образов замороженного запроса с аккаунтом в вопросе «Отправить»: образа нет —
 * ошибка (отправка заблокирована), у референса другой образ или снимки изменились — предупреждение. У образа,
 * который нужно создать или привязать заново, — переход к референсу на «Исходниках».
 */
import type { ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Stack } from '@mui/material';
import FaceRetouchingNaturalOutlinedIcon from '@mui/icons-material/FaceRetouchingNaturalOutlined';
import type { SavedLookCheck } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { linkLocation, referenceAnchor } from '../../../components/linkTargets';

const TEXT: Record<SavedLookCheck['status'], (look: { entity: string; name: string }) => string> = {
  missing: savedLooksTexts.checkMissing,
  changed: savedLooksTexts.checkChanged,
  stale: savedLooksTexts.checkStale
};

export function RequestLookChecks({ checks }: { checks: SavedLookCheck[] }): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Stack spacing={1}>
      {checks.map((check) => (
        <Alert
          key={check.code}
          severity={check.status === 'missing' ? 'error' : 'warning'}
          action={
            check.status === 'stale' ? undefined : (
              <Button
                color="inherit"
                size="small"
                startIcon={<FaceRetouchingNaturalOutlinedIcon />}
                aria-label={`${savedLooksTexts.openFromCast}: ${check.entity}`}
                onClick={() => navigate(linkLocation({ path: '/project/sources', anchor: referenceAnchor(check.code) }, location))}
              >
                {savedLooksTexts.openFromCast}
              </Button>
            )
          }
        >
          {TEXT[check.status]({ entity: check.entity, name: check.name })}
        </Alert>
      ))}
    </Stack>
  );
}
