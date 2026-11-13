/**
 * Локальная модель расхода для историй: сводки планов (production.spend), бейджи списка, расход
 * клипа (production.projectSpend) и правка стоимости (setSpendAmount, priceAccepted) без журнала Go.
 * Суммы и пометки пересчитываются из записей так же, как их считает internal/spend.
 */
import type { ProjectSpend, ShotSpend, ShotSpendBadge, SpendEntry, SpendRef, SpendTotal } from '@shared/types';

/** Расход плана без отправок. */
export function emptySpend(): ShotSpend {
  return {
    attempts: 0,
    removed: 0,
    images: 0,
    videos: 0,
    ownImages: 0,
    rejected: 0,
    unknown: 0,
    unpriced: 0,
    missing: false,
    manual: 0,
    totals: [],
    acceptedSeconds: null,
    perSecond: [],
    entries: []
  };
}

/** Запись расхода плана shot: по умолчанию видео сервиса с известным списанием. */
export function spendEntry(shot: string, overrides: Partial<Omit<SpendEntry, 'ref'>> & { ref?: Partial<SpendRef> } = {}): SpendEntry {
  const { ref, ...rest } = overrides;
  return {
    kind: 'video',
    provider: null,
    status: 'sent',
    amount: null,
    unit: null,
    frame: '',
    accepted: false,
    kit: false,
    removed: false,
    userAmount: false,
    editable: false,
    ...rest,
    ref: {
      shot,
      attempt: `plan/batches/${shot}-attempt-01`,
      kind: rest.kind ?? 'video',
      provider: rest.provider ?? '',
      requestSha256: `${shot}-${rest.frame || rest.kind || 'video'}-${Math.random().toString(36).slice(2)}`,
      generationId: null,
      frame: rest.frame ?? '',
      fileSha256: rest.frame ? `${shot}-${rest.frame}` : '',
      ...ref
    }
  };
}

/** Суммы, счётчики и пометки по записям; без записей сводка остаётся как задана. */
export function recomputeSpend(spend: ShotSpend): ShotSpend {
  if (!spend.entries.length) return spend;
  const totals: SpendTotal[] = [];
  let unknown = 0;
  let unpriced = spend.missing ? 1 : 0;
  for (const entry of spend.entries) {
    if (entry.amount === null) {
      if (entry.frame) continue;
      if (entry.status === 'manual') unpriced++;
      else unknown++;
      continue;
    }
    const total = totals.find((item) => item.provider === entry.provider && item.unit === entry.unit);
    if (total) total.amount += entry.amount;
    else totals.push({ provider: entry.provider, unit: entry.unit, amount: entry.amount });
  }
  const seconds = spend.acceptedSeconds;
  return {
    ...spend,
    totals,
    unknown,
    unpriced,
    perSecond: seconds ? totals.map((total) => ({ ...total, amount: total.amount / seconds })) : []
  };
}

/** Бейдж плана по сводке, как ShotSpendBadge Go. */
export function spendBadge(shot: string, spend: ShotSpend): ShotSpendBadge {
  return {
    shot,
    totals: spend.totals,
    unknown: spend.unknown,
    unpriced: spend.unpriced,
    missing: spend.missing,
    entries: Math.max(spend.entries.length, spend.images + spend.videos)
  };
}

/** Одна запись: совпадают попытка, вид, запрос, номер генерации и опора. */
function sameRef(a: SpendRef, b: SpendRef): boolean {
  return (
    a.attempt === b.attempt &&
    a.kind === b.kind &&
    a.requestSha256 === b.requestSha256 &&
    a.generationId === b.generationId &&
    a.frame === b.frame &&
    a.fileSha256 === b.fileSha256
  );
}

/** Модель расхода планов: сводки по коду плана, правка и цена принятого плана. */
export function createSpendModel(initial: Record<string, ShotSpend>) {
  const spends = new Map(Object.entries(initial).map(([shot, spend]) => [shot, recomputeSpend(structuredClone(spend))]));
  const model = {
    edits: 0,
    spend: (shot: string): ShotSpend => structuredClone(spends.get(shot) ?? emptySpend()),
    badge: (shot: string): ShotSpendBadge | null => (spends.has(shot) ? spendBadge(shot, spends.get(shot)!) : null),
    setAmount: (ref: SpendRef, amount: number | null, unit: string): void => {
      const spend = spends.get(ref.shot);
      const entry = spend?.entries.find((item) => sameRef(item.ref, ref));
      if (!spend || !entry) throw new Error('Запись расхода не найдена: обновите страницу.');
      if (!entry.editable) throw new Error('Списание сообщил сервис: его сумма не правится.');
      entry.amount = amount;
      entry.unit = amount === null ? null : unit;
      entry.userAmount = true;
      spends.set(ref.shot, recomputeSpend(spend));
      model.edits++;
    },
    priceAccepted: (shot: string, amount: number, unit: string): void => {
      const spend = spends.get(shot);
      if (!spend?.missing) throw new Error('У принятого видео плана уже есть запись расхода: правьте её.');
      spend.missing = false;
      spend.videos++;
      spend.entries.push(
        spendEntry(shot, { status: 'manual', amount, unit, accepted: true, kit: true, editable: true, ref: { attempt: `assets/shots/${shot}` } })
      );
      spends.set(shot, recomputeSpend(spend));
      model.edits++;
    },
    project: (): ProjectSpend => {
      const result: ProjectSpend = { shots: [], totals: [], unpriced: [], unknown: [], videos: 0, images: 0, manual: 0, ownImages: 0, rejected: 0 };
      for (const [shot, spend] of [...spends].sort(([a], [b]) => a.localeCompare(b))) {
        result.shots.push(spendBadge(shot, spend));
        result.videos += spend.videos;
        result.images += spend.images;
        result.manual += spend.manual;
        result.ownImages += spend.ownImages;
        result.rejected += spend.rejected;
        if (spend.unpriced) result.unpriced.push(shot);
        if (spend.unknown) result.unknown.push(shot);
        for (const total of spend.totals) {
          const found = result.totals.find((item) => item.provider === total.provider && item.unit === total.unit);
          if (found) {
            found.amount += total.amount;
            found.shots.push(shot);
          } else result.totals.push({ ...total, shots: [shot] });
        }
      }
      return result;
    }
  };
  return model;
}
