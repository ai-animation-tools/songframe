/**
 * Расход плана в шапке выбранного плана: бейджи сумм и пометок (ShotProduction.spend) и кнопка
 * «Расход», открывающая окно с записями и правкой своей цены. План, который ещё ничего не стоил,
 * блока не получает.
 */
import { useState, type ReactElement } from 'react';
import { Stack } from '@mui/material';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { productionTexts } from '@shared/texts/production';
import type { ShotProduction } from '@shared/types';
import { ActionButton } from '../../../components';
import { hasSpend, SpendChips } from '../../../components/SpendChips';
import { ShotSpendDialog } from './ShotSpendDialog';

const texts = productionTexts.shotSpend;

export function ShotSpendSummary({ project, shot, onChanged }: { project: string; shot: ShotProduction; onChanged(): void }): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!hasSpend(shot.spend)) return null;
  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }} data-testid="shot-spend">
        <SpendChips badge={shot.spend} />
        <ActionButton size="small" startIcon={<ReceiptLongIcon />} title={texts.openHint} onClick={() => setOpen(true)}>
          {texts.open}
        </ActionButton>
      </Stack>
      {open ? <ShotSpendDialog project={project} shot={shot.id} onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </>
  );
}
