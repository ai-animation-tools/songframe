/** Показываем только подтверждённые CLI поля; неизвестные значения не подменяем предположениями о подписке. */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Divider, LinearProgress, Link, Stack, Typography, type Theme } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { AgentAccountResult } from '@shared/agents';
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/agent-providers';

const unknown = 'Не удалось уточнить';
const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
// Общая сетка сохраняет одну вертикаль значений аккаунта и всех показателей лимитов.
const fieldRowSx = { display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(140px, 0.65fr) minmax(0, 1fr)' }, columnGap: 2 };
const fieldListSx = { m: 0, display: 'grid', gap: 1 };

interface AccountField {
  label: string;
  value: string | null;
  tone?: 'warning' | 'error';
}

// warning.main на светлом фоне слишком бледен для текста, поэтому там берётся тёмный оттенок.
const toneColor = { warning: (theme: Theme) => theme.palette.warning[theme.palette.mode === 'light' ? 'dark' : 'main'], error: 'error.main' };

/** Порог считается от использованной доли: от 75% лимит заканчивается, от 90% почти исчерпан. */
function remaining(usedPercent: number): Pick<AccountField, 'value' | 'tone'> {
  const value = `${percent.format(100 - usedPercent)}%`;
  if (usedPercent >= 100) return { value: `${value} (Лимит исчерпан)`, tone: 'error' };
  if (usedPercent >= 90) return { value: `${value} (Лимит почти исчерпан)`, tone: 'error' };
  if (usedPercent >= 75) return { value: `${value} (Лимит заканчивается)`, tone: 'warning' };
  return { value };
}

function date(value: string | number | null): string {
  if (value === null || value === '') return unknown;
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? unknown : parsed.toLocaleString('ru-RU');
}

interface Props {
  provider: AgentProvider;
  result: AgentAccountResult | null;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  onRefresh(): void;
}

export function AgentAccountPanel({ provider, result, loading, failed, disabled, onRefresh }: Props): ReactElement {
  const available = result?.diagnostic.availability === 'available';
  const authorization = result ? { authenticated: 'Вход выполнен', unauthenticated: 'Вход не выполнен', unknown }[result.diagnostic.authorization] : unknown;
  const fields: AccountField[] =
    available && result
      ? [
          { label: 'Вход', value: authorization, ...(result.diagnostic.authorization === 'unauthenticated' ? { tone: 'error' as const } : {}) },
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
        // Цвет дублируется текстом пометки; неизвестные показатели остаются нейтральными.
        { label: 'Осталось', ...remaining(limit.usedPercent) },
        { label: 'Окно', value: limit.windowMinutes === null ? unknown : `${limit.windowMinutes} мин` },
        { label: 'Сброс', value: date(limit.resetsAt) }
      ])
    : [[{ label: 'Лимит', value: unknown }]];
  return (
    <Stack spacing={1.5}>
      <Divider />
      <Typography fontWeight={600}>Аккаунт и лимиты</Typography>
      {/* Ссылка открывается во внешнем браузере; там видны полные сведения подписки, которые CLI может не отдавать. */}
      <Link
        href={AGENT_PROVIDERS[provider].accountUrl}
        target="_blank"
        rel="noreferrer"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, alignSelf: 'flex-start' }}
      >
        Личный кабинет {AGENT_PROVIDERS[provider].title}
        <OpenInNewIcon fontSize="inherit" aria-hidden="true" />
      </Link>
      <Typography variant="body2" color="text.secondary">
        Сведения относятся к выбранному агенту и его текущему входу. Чтение не сохраняет форму и не запускает генерацию.
      </Typography>
      {loading && <LinearProgress aria-label="Чтение аккаунта" />}
      {failed && <Alert severity="warning">{unknown}</Alert>}
      {/* message формируется приложением; служебный diagnostic.message здесь не выводим. */}
      {!loading && result && (result.message || result.usageAllowed === false) && (
        <Alert severity={result.usageAllowed === false ? 'error' : 'warning'}>
          {result.message || `${AGENT_PROVIDERS[provider].title} сообщает об ограничении использования.`}
        </Alert>
      )}
      {!loading && result && !available && (
        <Typography variant="body2" role="status">
          Аккаунт не прочитан: {`${AGENT_PROVIDERS[provider].title} ${result.diagnostic.availability === 'not_found' ? 'не найден' : 'недоступен'}`}.
        </Typography>
      )}
      {!loading && available && result && (
        <Stack spacing={1} role="status" sx={{ overflowWrap: 'anywhere' }}>
          <Box component="dl" sx={fieldListSx}>
            {fields.map(({ label, value, tone }) => (
              <Box key={label} sx={fieldRowSx}>
                <Typography component="dt" variant="body2" color="text.secondary" fontWeight={600}>
                  {label}
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, color: tone ? toneColor[tone] : 'text.primary', fontWeight: tone ? 600 : undefined }}>
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
              {group.map(({ label, value, tone }) => (
                <Box key={label} sx={fieldRowSx}>
                  <Typography component="dt" variant="body2" color="text.secondary" fontWeight={600}>
                    {label}
                  </Typography>
                  <Typography component="dd" variant="body2" sx={{ m: 0, color: tone ? toneColor[tone] : 'text.primary', fontWeight: tone ? 600 : undefined }}>
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
