/** Сообщение о потере сети в закреплённой шапке приложения; закрытое скрывается до следующего отключения или перезапуска. */
import { commonTexts } from '@shared/texts/common';
import { useEffect, useState, type ReactElement } from 'react';
import { Alert } from '@mui/material';
import { useApp } from '../state';

export function NetworkErrorMessage(): ReactElement | null {
  const { online } = useApp();
  const [dismissed, setDismissed] = useState(false);
  // Новое отключение снова показывает сообщение, даже если прошлое было закрыто.
  useEffect(() => {
    if (online) setDismissed(false);
  }, [online]);
  if (online || dismissed) return null;
  return (
    <Alert severity="error" onClose={() => setDismissed(true)} slotProps={{ closeButton: { title: commonTexts.network.dismiss } }} sx={{ borderRadius: 0 }}>
      {commonTexts.network.offline}
    </Alert>
  );
}
