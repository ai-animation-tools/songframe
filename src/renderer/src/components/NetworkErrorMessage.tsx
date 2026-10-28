/** Сообщение о потере сети под шапкой приложения; закрытое скрывается до следующего отключения или перезапуска. */
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
    <Alert severity="error" onClose={() => setDismissed(true)} slotProps={{ closeButton: { title: 'Скрыть сообщение' } }} sx={{ mb: 2 }}>
      Нет подключения к сети. Генерация, задания агента, вход в Kling и загрузка модели недоступны до восстановления связи; просмотр и правка проекта работают.
    </Alert>
  );
}
