import type { ReactElement } from 'react';
import { Box, Checkbox, Chip, CircularProgress, FormControlLabel, Typography } from '@mui/material';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type { CheckInfo } from '@shared/types';
import type { CheckOutcome } from '../types';
import { ActionButton } from '../../../components/ActionButton';

interface CheckRowProps {
  check: CheckInfo;
  result: CheckOutcome | null;
  disabled: boolean;
  /** Почему проверку сейчас нельзя запустить. */
  disabledReason: string | null;
  strict: boolean;
  next: boolean;
  setStrict: (value: boolean) => void;
  setNext: (value: boolean) => void;
  onUpdateViews: () => Promise<void>;
  onRun: () => Promise<void>;
}

/** Показывает результат проверки и её собственные параметры запуска. */
export function CheckRow({ check, result, disabled, disabledReason, strict, next, setStrict, setNext, onUpdateViews, onRun }: CheckRowProps): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, pt: 1 }}>
      <Box sx={{ width: 24, pt: 0.25, display: 'flex', justifyContent: 'center' }}>
        {result ? (
          result.status === 'running' ? (
            <CircularProgress size={16} />
          ) : (
            <Chip
              size="small"
              color={result.status === 'done' ? 'success' : result.status === 'skipped' ? 'default' : 'error'}
              label={result.status === 'done' ? 'ok' : result.status === 'skipped' ? 'пропуск' : result.code}
              sx={{ height: 20, minWidth: 32 }}
            />
          )
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600}>
          {check.label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {check.description}
        </Typography>
      </Box>
      {check.id === 'lint' ? (
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={strict} onChange={(e) => setStrict(e.target.checked)} />}
          label={<Typography variant="caption">Предупреждения считать ошибками</Typography>}
        />
      ) : null}
      {check.id === 'status' ? (
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={next} onChange={(e) => setNext(e.target.checked)} />}
          label={<Typography variant="caption">Следующий план и очередь</Typography>}
        />
      ) : null}
      {check.id === 'views' ? (
        <ActionButton
          size="small"
          startIcon={<AutorenewIcon />}
          title="Пересобрать монтажный список, раскадровку и карточки по реестру сцен"
          disabled={disabled}
          disabledReason={disabledReason}
          onClick={onUpdateViews}
        >
          Пересобрать карточки
        </ActionButton>
      ) : null}
      <ActionButton size="small" variant="outlined" startIcon={<PlayArrowIcon />} disabled={disabled} disabledReason={disabledReason} onClick={onRun}>
        Запустить
      </ActionButton>
    </Box>
  );
}
