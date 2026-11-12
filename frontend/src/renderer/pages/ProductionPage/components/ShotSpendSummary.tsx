/**
 * Расход плана в шапке выбранного плана: сколько было попыток и отправок, известный расход в
 * исходных единицах по источникам, неизвестный расход отдельно и, у принятого плана, отклонённые
 * варианты и стоимость секунды принятого материала. Сведения считает Go (production.spend) по
 * журналу plan/spend.json и живым попыткам; без отправок блок не показывается.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import { mediaProviderInfo } from '@shared/media-providers';
import { productionTexts } from '@shared/texts/production';
import type { ShotProduction, ShotSpend, SpendTotal } from '@shared/types';
import { useApp } from '../../../state';

const texts = productionTexts.shotSpend;

/** Источник суммы: название сервиса из реестра или ручная генерация. */
function sourceTitle(total: SpendTotal): string {
  if (total.provider === null) return texts.manualSource;
  return mediaProviderInfo(total.provider, 'video')?.title ?? mediaProviderInfo(total.provider, 'image')?.title ?? total.provider;
}

/** Суммы через точку с источником в скобках: кредиты разных сервисов не складываются. */
function totalsText(totals: SpendTotal[]): string {
  return totals.map((total) => `${texts.amount(total)} (${sourceTitle(total)})`).join(' · ');
}

/** Отпечаток состояния плана: расход перечитывается после отправки, приёмки и удаления попытки. */
function spendKey(shot: ShotProduction): string {
  return [shot.id, shot.asset?.video ?? '', ...shot.packages.map((pkg) => `${pkg.dir}:${pkg.stage}:${pkg.request?.attemptStatus ?? ''}`)].join('|');
}

export function ShotSpendSummary({ project, shot }: { project: string; shot: ShotProduction }): ReactElement | null {
  const { describeError } = useApp();
  const [spend, setSpend] = useState<ShotSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = spendKey(shot);

  useEffect(() => {
    let active = true;
    setError(null);
    window.api.production
      .spend(project, shot.id)
      .then((next) => {
        if (active) setSpend(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(texts.loadFailed({ reason: describeError(reason) }));
      });
    return () => {
      active = false;
    };
    // key включает shot.id и состояние попыток.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, key, describeError]);

  if (error)
    return (
      <Alert severity="error" sx={{ mt: 1.5 }}>
        {error}
      </Alert>
    );
  if (!spend || spend.images + spend.videos === 0) return null;
  const seconds = spend.acceptedSeconds;
  return (
    <Stack spacing={0.75} sx={{ mt: 1.5 }} data-testid="shot-spend">
      <Typography variant="subtitle2">{texts.heading}</Typography>
      <Typography variant="body2">{texts.sends(spend)}</Typography>
      <Typography variant="body2">
        {texts.spent}: {spend.totals.length ? totalsText(spend.totals) : texts.noKnown}
      </Typography>
      {seconds !== null ? (
        <>
          <Typography variant="body2">{texts.accepted({ seconds: seconds.toFixed(2).replace('.', ','), rejected: spend.rejected })}</Typography>
          {spend.perSecond.length ? (
            <Typography variant="body2" fontWeight={500}>
              {texts.perSecond}: {totalsText(spend.perSecond)}
            </Typography>
          ) : null}
        </>
      ) : null}
      {/* Неизвестный расход — заметное предупреждение: суммы выше тогда только нижняя граница. */}
      {spend.unknown ? (
        <Alert severity="warning" title={texts.unknownHint}>
          {texts.unknown({ count: spend.unknown })}
        </Alert>
      ) : null}
    </Stack>
  );
}
