import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material';
import TheatersIcon from '@mui/icons-material/Theaters';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ScenarioStatus } from '@shared/scenario-status';
import { LinkedText } from './LinkedText';

/** Отсутствие сценария оформляется одинаково на всех зависимых страницах, на всю рабочую ширину. */
export function ScenarioRequired({
  title,
  status,
  onRefresh
}: {
  title: string;
  status: Exclude<ScenarioStatus, 'ready'>;
  onRefresh: () => void;
}): ReactElement {
  const heading = status === 'missing' ? 'Сначала нужен сценарий' : status === 'empty' ? 'В сценарии пока нет сцен' : 'Не удалось прочитать сценарий';
  const message =
    status === 'missing'
      ? 'Создайте сценарий и добавьте в него сцены.'
      : status === 'empty'
        ? 'Добавьте сцены на странице «Сценарий», чтобы продолжить работу.'
        : 'Проверьте сценарий на странице «Сценарий», затем обновите эту страницу.';
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <Typography variant="h5">{title}</Typography>
      <Alert severity={status === 'invalid' ? 'error' : 'info'}>
        <AlertTitle>{heading}</AlertTitle>
        <LinkedText text={message} />
      </Alert>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button component={Link} to="/project/scenario" variant="contained" startIcon={<TheatersIcon />}>
          Открыть сценарий
        </Button>
        <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
          Обновить
        </Button>
      </Stack>
    </Stack>
  );
}
