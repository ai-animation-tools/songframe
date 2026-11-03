import { useEffect, useState } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import { useNavigate } from 'react-router-dom';
import type { ComponentsApi, OperationState } from '@platform/components';
import { componentTexts as text } from '@shared/texts/components';
import { ActionButton } from '../../../components/ActionButton';

/** Контекстная ссылка показывает требования будущей обработки, сохраняя доступность чтения таймингов.
 * Чтение статуса не запускает probes и установку; возврат не повторяет исходную операцию автоматически.
 */
export function ComponentsNotice({ api }: { api: ComponentsApi }) {
  const [operation, setOperation] = useState<OperationState | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    let disposed = false;
    void api.state().then(
      (snapshot) => {
        if (!disposed) setOperation(snapshot.operations.find((item) => item.id === 'known-text-ctc') ?? null);
      },
      () => undefined
    );
    return () => {
      disposed = true;
    };
  }, [api]);
  return (
    <Alert severity={operation?.status === 'ready' ? 'success' : 'info'}>
      <Stack spacing={1}>
        <Typography fontWeight={600}>{text.contextTitle}</Typography>
        <Typography variant="body2">{operation?.reason ?? text.contextHint}</Typography>
        <ActionButton
          startIcon={<BuildIcon />}
          onClick={() => navigate('/components?operation=known-text-ctc&returnTo=/project/timing')}
          sx={{ alignSelf: 'flex-start' }}
        >
          {text.open}
        </ActionButton>
      </Stack>
    </Alert>
  );
}
