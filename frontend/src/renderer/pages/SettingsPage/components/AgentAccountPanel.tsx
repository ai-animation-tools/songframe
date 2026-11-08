import { settingsTexts } from '@shared/texts/settings';
import { commonTexts } from '@shared/texts/common';
import { technicalTexts } from '@shared/texts/technical';
/** Показываем только подтверждённые CLI поля; неизвестные значения не подменяем предположениями о подписке. */
import type { ReactElement } from 'react';
import { Alert, Box, Divider, LinearProgress, Link, Stack, Typography, type Theme } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { AgentAccountResult } from '@shared/agents';
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/agent-providers';
import { formatDateTime } from '../../../format';
import { ActionButton } from '../../../components/ActionButton';

const unknown = settingsTexts.unknownAccount;
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
  const value = technicalTexts.percent(percent.format(100 - usedPercent));
  if (usedPercent >= 100) return { value: settingsTexts.limitExhausted(value), tone: 'error' };
  if (usedPercent >= 90) return { value: settingsTexts.limitAlmostExhausted(value), tone: 'error' };
  if (usedPercent >= 75) return { value: settingsTexts.limitRunningOut(value), tone: 'warning' };
  return { value };
}

function date(value: string | number | null): string {
  if (value === null || value === '') return unknown;
  // CLI отдаёт время сброса в секундах Unix, остальное — строками ISO.
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? unknown : formatDateTime(parsed);
}

interface Props {
  provider: AgentProvider;
  result: AgentAccountResult | null;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  /** Почему обновление сейчас недоступно (сохранение, нет сети). */
  disabledReason?: string | null;
  onRefresh(): void;
}

export function AgentAccountPanel({ provider, result, loading, failed, disabled, disabledReason, onRefresh }: Props): ReactElement {
  const available = result?.diagnostic.availability === 'available';
  const authorization = result
    ? { authenticated: settingsTexts.authenticated, unauthenticated: settingsTexts.unauthenticated, unknown }[result.diagnostic.authorization]
    : unknown;
  const fields: AccountField[] =
    available && result
      ? [
          { label: settingsTexts.login, value: authorization, ...(result.diagnostic.authorization === 'unauthenticated' ? { tone: 'error' as const } : {}) },
          { label: settingsTexts.email, value: result.email },
          { label: settingsTexts.organization, value: result.organization },
          { label: settingsTexts.authenticationMethod, value: result.authenticationMethod },
          { label: settingsTexts.plan, value: result.plan },
          { label: settingsTexts.subscriptionStatus, value: result.subscriptionStatus },
          { label: settingsTexts.subscriptionExpires, value: date(result.subscriptionExpiresAt) },
          { label: settingsTexts.credits, value: result.credits }
        ]
      : [];
  const limitGroups: AccountField[][] = result?.limits?.length
    ? result.limits.map((limit) => [
        { label: settingsTexts.limit, value: limit.label },
        { label: settingsTexts.used, value: technicalTexts.percent(percent.format(limit.usedPercent)) },
        // Цвет дублируется текстом пометки; неизвестные показатели остаются нейтральными.
        { label: settingsTexts.remaining, ...remaining(limit.usedPercent) },
        { label: settingsTexts.window, value: limit.windowMinutes === null ? unknown : settingsTexts.minutes(limit.windowMinutes) },
        { label: settingsTexts.resets, value: date(limit.resetsAt) }
      ])
    : [[{ label: settingsTexts.limit, value: unknown }]];
  return (
    <Stack spacing={1.5}>
      <Divider />
      <Typography fontWeight={600}>{settingsTexts.accountTitle}</Typography>
      {/* Ссылка открывается во внешнем браузере; там видны полные сведения подписки, которые CLI может не отдавать. */}
      <Link
        href={AGENT_PROVIDERS[provider].accountUrl}
        target="_blank"
        rel="noreferrer"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, alignSelf: 'flex-start' }}
      >
        {settingsTexts.accountLink(AGENT_PROVIDERS[provider].title)}
        <OpenInNewIcon fontSize="inherit" aria-hidden="true" />
      </Link>
      <Typography variant="body2" color="text.secondary">
        {settingsTexts.accountExplanation}
      </Typography>
      {loading && <LinearProgress aria-label={settingsTexts.readingAccount} />}
      {failed && <Alert severity="warning">{unknown}</Alert>}
      {/* message формируется приложением; служебный diagnostic.message здесь не выводим. */}
      {!loading && result && (result.message || result.usageAllowed === false) && (
        <Alert severity={result.usageAllowed === false ? 'error' : 'warning'}>
          {result.message || settingsTexts.usageRestricted(AGENT_PROVIDERS[provider].title)}
        </Alert>
      )}
      {!loading && result && !available && (
        <Typography variant="body2" role="status">
          {settingsTexts.accountUnavailable({ name: AGENT_PROVIDERS[provider].title, missing: result.diagnostic.availability === 'not_found' })}
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
            {settingsTexts.limits}
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
            {settingsTexts.checkedAt(date(result.checkedAt))}
          </Typography>
        </Stack>
      )}
      <ActionButton
        sx={{ alignSelf: 'flex-start' }}
        startIcon={<RefreshIcon />}
        disabled={disabled || loading}
        disabledReason={(disabled ? disabledReason : null) ?? (loading ? settingsTexts.waitForAccount : null)}
        onClick={onRefresh}
      >
        {commonTexts.refresh}
      </ActionButton>
    </Stack>
  );
}
