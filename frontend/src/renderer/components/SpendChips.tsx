/**
 * Бейджи расхода плана: известные суммы в единицах своего источника и заметные пометки о неполном
 * расходе. Одна сумма — один бейдж: кредиты разных сервисов, рубли и доллары не складываются.
 * Суммы показывает шапка выбранного плана на «Производстве»; список планов получает только пометки
 * (attentionOnly), чтобы суммы в разных единицах не перегружали карточки. Данные — бейдж Go
 * (ShotProduction.spend) по журналу расхода.
 */
import type { ReactElement } from 'react';
import { Chip, Stack } from '@mui/material';
import { mediaProviderInfo } from '@shared/media-providers';
import { productionTexts } from '@shared/texts/production';
import type { ShotSpendBadge, SpendTotal } from '@shared/types';

const texts = productionTexts.shotSpend;

/** Источник суммы: название сервиса из реестра или материал, созданный вне приложения. */
export function spendSource(provider: string | null): string {
  if (provider === null) return texts.manualSource;
  return mediaProviderInfo(provider, 'video')?.title ?? mediaProviderInfo(provider, 'image')?.title ?? provider;
}

/** Сумма в исходной единице: «24,5 кредита», «120 ₽». */
export function spendAmount(total: Pick<SpendTotal, 'amount' | 'unit'>): string {
  return texts.amount(total);
}

/** Есть ли что показать: у плана были записи расхода или принятое видео без записи. */
export function hasSpend(badge: ShotSpendBadge | null | undefined): badge is ShotSpendBadge {
  return !!badge && (badge.entries > 0 || badge.missing);
}

/** Бейджи расхода; attentionOnly — только пометки о неполном расходе, компактно, для списка планов. */
export function SpendChips({ badge, attentionOnly = false }: { badge: ShotSpendBadge | null | undefined; attentionOnly?: boolean }): ReactElement | null {
  if (!hasSpend(badge)) return null;
  if (attentionOnly && !badge.unpriced && !badge.unknown) return null;
  const sx = attentionOnly ? { height: 18 } : undefined;
  const calm = !badge.totals.length && !badge.unpriced && !badge.unknown;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" alignItems="center" data-testid="spend-chips" component="span">
      {(attentionOnly ? [] : badge.totals).map((total) => (
        <Chip
          key={`${total.provider ?? ''}:${total.unit ?? ''}`}
          size="small"
          color="primary"
          label={spendAmount(total)}
          title={texts.chipSource({ source: spendSource(total.provider) })}
          sx={sx}
        />
      ))}
      {badge.unpriced ? <Chip size="small" color="warning" label={texts.chipUnpriced} title={texts.chipUnpricedHint} sx={sx} /> : null}
      {badge.unknown ? <Chip size="small" color="warning" variant="outlined" label={texts.chipUnknown} title={texts.chipUnknownHint} sx={sx} /> : null}
      {calm ? <Chip size="small" variant="outlined" label={texts.chipNone} title={texts.chipNoneHint} sx={sx} /> : null}
    </Stack>
  );
}
