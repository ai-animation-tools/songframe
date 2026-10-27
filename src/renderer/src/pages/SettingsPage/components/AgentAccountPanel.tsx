/** Показываем только подтверждённые CLI поля; неизвестные значения не подменяем предположениями о подписке. */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Divider, LinearProgress, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { AgentAccountResult } from '@shared/agents';

const unknown = 'Не удалось уточнить';
const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
// Общая сетка сохраняет одну вертикаль значений аккаунта и всех показателей лимитов.
const fieldRowSx = { display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(140px, 0.65fr) minmax(0, 1fr)' }, columnGap: 2 };
const fieldListSx = { m: 0, display: 'grid', gap: 1 };

interface AccountField {
  label: string;
  value: string | null;
  error?: boolean;
}

function date(value: string | number | null): string {
  if (value === null || value === '') return unknown;
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? unknown : parsed.toLocaleString('ru-RU');
}

interface Props {
  result: AgentAccountResult | null;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  onRefresh(): void;
}

export function AgentAccountPanel({ result, loading, failed, disabled, onRefresh }: Props): ReactElement {
  const available = result?.diagnostic.availability === 'available';
  const authorization = result ? { authenticated: 'Вход выполнен', unauthenticated: 'Вход не выполнен', unknown }[result.diagnostic.authorization] : unknown;
  const fields: AccountField[] =
    available && result
      ? [
          { label: 'Вход', value: authorization, error: result.diagnostic.authorization === 'unauthenticated' },
          { label: 'Аккаунт (email)', value: result.email },
          { label: 'Организация', value: result.organization },
          { label: 'Способ входа', value: result.authenticationMethod },
          { label: 'Тариф', value: result.plan },
          { label: 'Статус подписки', value: result.subscriptionStatus },
          { label: 'Срок подписки', value: date(result.subscriptionExpiresAt) },
          { label: 'Кредиты', value: result.credits }
        ]
      : [];
  const limitGroups: AccountField[][] = result?.limits?.length
    ? result.limits.map((limit) => [
        { label: 'Лимит', value: limit.label },
        { label: 'Использовано', value: `${percent.format(limit.usedPercent)}%` },
        // Остаток 10% и меньше требует внимания; неизвестные показатели остаются нейтральными.
        {
          label: 'Осталось',
          value: `${percent.format(100 - limit.usedPercent)}%${limit.usedPercent >= 100 ? ' (Лимит исчерпан)' : ''}`,
          error: limit.usedPercent >= 90
        },
        { label: 'Окно', value: limit.windowMinutes === null ? unknown : `${limit.windowMinutes} мин` },
        { label: 'Сброс', value: date(limit.resetsAt) }
      ])
    : [[{ label: 'Лимит', value: unknown }]];
  return (
    <Stack spacing={1.5}>
      <Divider />
      <Typography fontWeight={600}>Аккаунт и лимиты CLI</Typography>
      <Typography variant="body2" color="text.secondary">
        Сведения относятся к выбранному CLI и его текущему входу. Чтение не сохраняет форму и не запускает генерацию.
      </Typography>
      {loading && <LinearProgress aria-label="Чтение аккаунта CLI" />}
      {failed && <Alert severity="warning">{unknown}</Alert>}
      {/* message формируется приложением; служебный diagnostic.message здесь не выводим. */}
      {!loading && result && (result.message || result.usageAllowed === false) && (
        <Alert severity={result.usageAllowed === false ? 'error' : 'warning'}>{result.message || 'CLI сообщает об ограничении использования.'}</Alert>
      )}
      {!loading && result && !available && (
        <Typography variant="body2" role="status">
          Аккаунт не прочитан: {result.diagnostic.availability === 'not_found' ? 'CLI не найден' : 'CLI недоступен'}.
        </Typography>
      )}
      {!loading && available && result && (
        <Stack spacing={1} role="status" sx={{ overflowWrap: 'anywhere' }}>
          <Box component="dl" sx={fieldListSx}>
            {fields.map(({ label, value, error }) => (
              <Box key={label} sx={fieldRowSx}>
                <Typography component="dt" variant="body2" color="text.secondary" fontWeight={600}>
                  {label}
                </Typography>
                <Typography component="dd" variant="body2" color={error ? 'error.main' : 'text.primary'} sx={{ m: 0 }}>
                  {value || unknown}
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="body2" fontWeight={600}>
            Лимиты
          </Typography>
          {limitGroups.map((group, index) => (
            <Box component="dl" key={index} sx={fieldListSx}>
              {group.map(({ label, value, error }) => (
                <Box key={label} sx={fieldRowSx}>
                  <Typography component="dt" variant="body2" color="text.secondary" fontWeight={600}>
                    {label}
                  </Typography>
                  <Typography component="dd" variant="body2" color={error ? 'error.main' : 'text.primary'} sx={{ m: 0 }}>
                    {value || unknown}
                  </Typography>
                </Box>
              ))}
            </Box>
          ))}
          <Typography variant="caption" color="text.secondary">
            Проверено: {date(result.checkedAt)}
          </Typography>
        </Stack>
      )}
      <Button sx={{ alignSelf: 'flex-start' }} startIcon={<RefreshIcon />} variant="outlined" disabled={disabled || loading} onClick={onRefresh}>
        Обновить
      </Button>
    </Stack>
  );
}
