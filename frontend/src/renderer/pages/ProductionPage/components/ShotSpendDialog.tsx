/**
 * Окно «Расход Mxx»: из чего сложилась стоимость плана и правка своей цены. Сверху — сводка
 * (попытки и отправки, известный расход, принятый материал и стоимость секунды), ниже — записи
 * по видео и опорам. Стоимость указывается у всего, что не сообщил сервис: видео вне приложения,
 * своя опора, отправка без списания, принятый план без записи. Правка пишет только журнал расхода
 * (production.setSpendAmount, production.priceAccepted), файлы попыток и комплекта не меняются.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import { productionTexts } from '@shared/texts/production';
import type { ManualCostUnit, ShotSpend, SpendEntry } from '@shared/types';
import { ActionButton } from '../../../components';
import { spendAmount, spendSource } from '../../../components/SpendChips';
import { useApp } from '../../../state';

const texts = productionTexts.shotSpend;
const units = productionTexts.manualGeneration.units;
const UNITS: ManualCostUnit[] = ['credits', 'RUB', 'USD'];

/** Подпись записи: что это и откуда. */
function entryLabel(entry: SpendEntry): string {
  if (entry.frame) return texts.ownFrame({ frame: entry.frame });
  if (entry.kind === 'image') return texts.imageSent({ source: spendSource(entry.provider) });
  if (entry.kit) return texts.videoKit;
  return entry.provider === null ? texts.videoManual : texts.videoSent({ source: spendSource(entry.provider) });
}

/** Отметки записи: принято или отклонено, попытка удалена, сумму указал пользователь. */
function entryMarks(entry: SpendEntry, accepted: boolean): string {
  return [
    entry.kind === 'video' && accepted ? (entry.accepted ? texts.acceptedMark : texts.rejectedMark) : '',
    entry.removed ? texts.removed : '',
    entry.userAmount ? texts.userAmount : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Стоимость записи или заметная пометка, почему её нет. */
function EntryAmount({ entry }: { entry: SpendEntry }): ReactElement {
  if (entry.amount !== null)
    return (
      <Typography variant="body2" fontWeight={600}>
        {spendAmount({ amount: entry.amount, unit: entry.unit })}
      </Typography>
    );
  if (entry.frame)
    return (
      <Typography variant="body2" color="text.secondary">
        {texts.ownNoPrice}
      </Typography>
    );
  return (
    <Typography variant="body2" fontWeight={600} color="warning.main">
      {entry.status === 'manual' ? texts.noPrice : texts.unknownCharge}
    </Typography>
  );
}

/** Поля стоимости: целое число и единица; «Снять цену» — только у уже указанной. */
function CostEditor({
  initial,
  busy,
  onSave,
  onClear,
  onCancel
}: {
  initial: { amount: number | null; unit: string | null };
  busy: boolean;
  onSave(amount: number, unit: ManualCostUnit): void;
  onClear?(): void;
  onCancel(): void;
}): ReactElement {
  const [amount, setAmount] = useState(initial.amount === null ? '' : String(initial.amount));
  const [unit, setUnit] = useState<ManualCostUnit>(UNITS.includes(initial.unit as ManualCostUnit) ? (initial.unit as ManualCostUnit) : 'credits');
  const value = Number(amount);
  const valid = amount.trim() !== '' && Number.isInteger(value) && value >= 0;
  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="flex-start" sx={{ mt: 1 }}>
      <TextField
        size="small"
        type="number"
        label={productionTexts.manualGeneration.cost}
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        error={amount.trim() !== '' && !valid}
        helperText={amount.trim() !== '' && !valid ? productionTexts.manualGeneration.costInvalid : undefined}
        slotProps={{ htmlInput: { min: 0, step: 1 } }}
        sx={{ width: 160 }}
        autoFocus
      />
      <TextField
        select
        size="small"
        label={productionTexts.manualGeneration.unit}
        value={unit}
        onChange={(event) => setUnit(event.target.value as ManualCostUnit)}
        sx={{ width: 140 }}
      >
        {UNITS.map((item) => (
          <MenuItem key={item} value={item}>
            {units[item]}
          </MenuItem>
        ))}
      </TextField>
      <Button variant="contained" disabled={busy || !valid} onClick={() => onSave(value, unit)}>
        {texts.save}
      </Button>
      {onClear ? (
        <Button disabled={busy} onClick={onClear}>
          {texts.clear}
        </Button>
      ) : null}
      <Button disabled={busy} onClick={onCancel}>
        {texts.cancel}
      </Button>
    </Stack>
  );
}

/** Ключ записи для выбора правки. */
function entryKey(entry: SpendEntry): string {
  const ref = entry.ref;
  return [ref.attempt, ref.kind, ref.requestSha256, ref.generationId ?? '', ref.frame, ref.fileSha256].join('|');
}

export function ShotSpendDialog({
  project,
  shot,
  onClose,
  onChanged
}: {
  project: string;
  shot: string;
  onClose(): void;
  /** Стоимость изменена: странице нужно перечитать бейджи. */
  onChanged(): void;
}): ReactElement {
  const { describeError, notify } = useApp();
  const [spend, setSpend] = useState<ShotSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSpend(await window.api.production.spend(project, shot));
      setError(null);
    } catch (reason) {
      setError(texts.loadFailed({ reason: describeError(reason) }));
    }
  }, [project, shot, describeError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
      setEditing(null);
      notify(texts.saved, 'success');
      onChanged();
      await load();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const accepted = spend?.acceptedSeconds !== null && spend?.acceptedSeconds !== undefined;
  const groups: { title: string; items: SpendEntry[] }[] = spend
    ? [
        { title: texts.videos, items: spend.entries.filter((entry) => entry.kind === 'video') },
        { title: texts.frames, items: spend.entries.filter((entry) => entry.kind === 'image') }
      ].filter((group) => group.items.length)
    : [];

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth aria-labelledby="shot-spend-title">
      <DialogTitle id="shot-spend-title">{texts.title({ shot })}</DialogTitle>
      <DialogContent dividers>
        {error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        ) : null}
        {spend ? (
          <Stack spacing={1.5}>
            <Stack spacing={0.5}>
              <Typography variant="body2">{texts.sends(spend)}</Typography>
              <Typography variant="body2">
                {texts.spent}:{' '}
                {spend.totals.length ? spend.totals.map((total) => `${spendAmount(total)} (${spendSource(total.provider)})`).join(' · ') : texts.noKnown}
              </Typography>
              {spend.acceptedSeconds !== null ? (
                <Typography variant="body2">
                  {texts.acceptedTotal({ seconds: spend.acceptedSeconds.toFixed(2).replace('.', ','), rejected: spend.rejected })}
                </Typography>
              ) : null}
              {spend.perSecond.length ? (
                <Typography variant="body2" fontWeight={500}>
                  {texts.perSecond}: {spend.perSecond.map((total) => `${spendAmount(total)} (${spendSource(total.provider)})`).join(' · ')}
                </Typography>
              ) : null}
            </Stack>
            {spend.unknown ? (
              <Alert severity="warning" title={texts.unknownHint}>
                {texts.unknown({ count: spend.unknown })}
              </Alert>
            ) : null}
            {spend.unpriced - (spend.missing ? 1 : 0) > 0 ? (
              <Alert severity="warning">{texts.unpriced({ count: spend.unpriced - (spend.missing ? 1 : 0) })}</Alert>
            ) : null}
            {spend.missing ? (
              <Alert severity="warning" data-testid="spend-missing">
                {texts.missing}
                {editing === 'kit' ? (
                  <CostEditor
                    initial={{ amount: null, unit: null }}
                    busy={busy}
                    onSave={(amount, unit) => void save(() => window.api.production.priceAccepted(project, shot, amount, unit))}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <Box sx={{ mt: 1 }}>
                    <ActionButton size="small" variant="outlined" startIcon={<EditIcon />} disabled={busy} onClick={() => setEditing('kit')}>
                      {texts.priceAccepted}
                    </ActionButton>
                  </Box>
                )}
              </Alert>
            ) : null}
            {groups.map((group) => (
              <Box key={group.title}>
                <Typography variant="subtitle2" gutterBottom>
                  {group.title}
                </Typography>
                <Stack divider={<Divider flexItem />} spacing={1}>
                  {group.items.map((entry) => {
                    const key = entryKey(entry);
                    const marks = entryMarks(entry, accepted);
                    return (
                      <Box key={key} data-testid="spend-entry">
                        <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
                          <Box sx={{ flex: 1, minWidth: 220 }}>
                            <Typography variant="body2">{entryLabel(entry)}</Typography>
                            {marks ? (
                              <Typography variant="caption" color="text.secondary">
                                {marks}
                              </Typography>
                            ) : null}
                          </Box>
                          <EntryAmount entry={entry} />
                          {entry.editable && editing !== key ? (
                            <Button
                              size="small"
                              startIcon={<EditIcon />}
                              disabled={busy}
                              onClick={() => setEditing(key)}
                              aria-label={`${entry.amount === null ? texts.set : texts.edit}: ${entryLabel(entry)}`}
                            >
                              {entry.amount === null ? texts.set : texts.edit}
                            </Button>
                          ) : null}
                        </Stack>
                        {editing === key ? (
                          <CostEditor
                            initial={entry}
                            busy={busy}
                            onSave={(amount, unit) => void save(() => window.api.production.setSpendAmount(project, entry.ref, amount, unit))}
                            onClear={
                              entry.amount === null ? undefined : () => void save(() => window.api.production.setSpendAmount(project, entry.ref, null, ''))
                            }
                            onCancel={() => setEditing(null)}
                          />
                        ) : null}
                      </Box>
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{texts.close}</Button>
      </DialogActions>
    </Dialog>
  );
}
