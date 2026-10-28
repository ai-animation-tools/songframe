/** Очередь показывает отложенные запросы явно; открытие пакета не отправляет генерацию. */
import type { ReactElement } from 'react';
import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import type { BrokenPackage, PackageView } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { FILTER_EMPTY_HINTS } from '../constants';

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
        <Typography variant="h6">Очередь ({packages.length + broken.length})</Typography>
        <Typography variant="body2" color="text.secondary">
          Сохранённые запросы ждут продолжения, генерация автоматически не запускается. «Открыть запрос» показывает его материалы: кнопка «Отправить» заново
          проверит стоимость и запросит подтверждение, «Отказаться от попытки» удалит запрос из очереди.
        </Typography>
        {!packages.length && !broken.length ? (
          <>
            <Alert severity="info">{FILTER_EMPTY_HINTS.queued}</Alert>
            {onResetFilter ? (
              <Button size="small" startIcon={<FilterAltOffIcon />} onClick={onResetFilter} sx={{ alignSelf: 'start' }}>
                Показать все планы
              </Button>
            ) : null}
          </>
        ) : null}
        {packages.map((pkg) => (
          <Stack key={pkg.dir} spacing={1} sx={{ borderLeft: 3, borderColor: pkg.dir === selected ? 'primary.main' : 'divider', pl: 1.5, minWidth: 0 }}>
            <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {pkg.shot}
              {pkg.request?.frameId ? ` · опора ${pkg.request.frameId}` : ''}
            </Typography>
            <Chip size="small" variant="outlined" label="В очереди" sx={{ alignSelf: 'start' }} />
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {pkg.relative}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Кнопка «Отправить» откроет проверку стоимости и отдельное подтверждение.
            </Typography>
            <Button size="small" startIcon={<FolderOpenIcon />} onClick={() => onOpen(pkg)} sx={{ alignSelf: 'start' }}>
              Открыть запрос
            </Button>
          </Stack>
        ))}
        {broken.map((item) => (
          <Stack key={item.dir} spacing={1} sx={{ borderLeft: 3, borderColor: 'error.main', pl: 1.5, minWidth: 0 }}>
            <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {item.shot ?? 'Без плана'}
            </Typography>
            <Chip size="small" color="error" variant="outlined" label="Повреждённая папка" sx={{ alignSelf: 'start' }} />
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {item.relative}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {item.reason}. Запроса в ней нет, открыть её нельзя; пока папка есть, план {item.shot ?? ''} не сохранить в очередь.
            </Typography>
            <DestructiveButton
              label="Удалить папку"
              description={`Папка ${item.relative} будет удалена безвозвратно вместе со всем содержимым. Принятый комплект сцены и исходники не затрагиваются.`}
              confirmLabel="Удалить папку"
              startIcon={<DeleteForeverIcon />}
              variant="outlined"
              disabled={busy}
              onConfirm={() => onDiscardBroken(item)}
              sx={{ alignSelf: 'start' }}
            />
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}
