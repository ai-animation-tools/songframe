import { productionTexts } from '@shared/texts/production';
/** Очередь показывает отложенные запросы явно; открытие пакета не отправляет генерацию. */
import type { ReactElement } from 'react';
import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import type { BrokenPackage, PackageView } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { BUSY_REASON, FILTER_EMPTY_HINTS } from '../constants';

export function ProductionQueue({
  packages,
  broken,
  selected,
  busy,
  onOpen,
  onDiscardBroken,
  onResetFilter
}: {
  packages: PackageView[];
  broken: BrokenPackage[];
  selected: string;
  busy: boolean;
  onOpen(pkg: PackageView): void;
  onDiscardBroken(item: BrokenPackage): void;
  /** Возврат к полному списку планов, как у пустого фильтра списка. */
  onResetFilter?(): void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{productionTexts.productionQueue.heading({ count: packages.length + broken.length })}</Typography>
        <Typography variant="body2" color="text.secondary">
          {productionTexts.productionQueue.description}
        </Typography>
        {!packages.length && !broken.length ? (
          <>
            <Alert severity="info">{FILTER_EMPTY_HINTS.queued}</Alert>
            {onResetFilter ? (
              <Button size="small" startIcon={<FilterAltOffIcon />} onClick={onResetFilter} sx={{ alignSelf: 'start' }}>
                {productionTexts.productionQueue.showAll}
              </Button>
            ) : null}
          </>
        ) : null}
        {packages.map((pkg) => (
          <Stack key={pkg.dir} spacing={1} sx={{ borderLeft: 3, borderColor: pkg.dir === selected ? 'primary.main' : 'divider', pl: 1.5, minWidth: 0 }}>
            <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {productionTexts.productionQueue.frame({ shot: pkg.shot, frameId: pkg.request?.frameId })}
            </Typography>
            <Chip size="small" variant="outlined" label={productionTexts.productionQueue.queued} sx={{ alignSelf: 'start' }} />
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {pkg.relative}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {productionTexts.productionQueue.sendHint}
            </Typography>
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(pkg)} sx={{ alignSelf: 'start' }}>
              {productionTexts.productionQueue.open}
            </Button>
          </Stack>
        ))}
        {broken.map((item) => (
          <Stack key={item.dir} spacing={1} sx={{ borderLeft: 3, borderColor: 'error.main', pl: 1.5, minWidth: 0 }}>
            <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {item.shot ?? productionTexts.productionQueue.noShot}
            </Typography>
            <Chip size="small" color="error" variant="outlined" label={productionTexts.productionQueue.broken} sx={{ alignSelf: 'start' }} />
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {item.relative}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {productionTexts.productionQueue.brokenHint({ reason: item.reason, shot: item.shot ?? '' })}
            </Typography>
            <DestructiveButton
              label={productionTexts.productionQueue.delete}
              description={productionTexts.productionQueue.deleteDescription({ relative: item.relative })}
              confirmLabel={productionTexts.productionQueue.deleteConfirm}
              startIcon={<DeleteForeverIcon />}
              variant="outlined"
              disabled={busy}
              disabledReason={BUSY_REASON}
              onConfirm={() => onDiscardBroken(item)}
              sx={{ alignSelf: 'start' }}
            />
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}
