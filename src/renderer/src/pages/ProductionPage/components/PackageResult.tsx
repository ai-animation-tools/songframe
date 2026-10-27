import GridViewIcon from '@mui/icons-material/GridView';
/** Скачанные оригиналы, техническая сводка и действие приёмки результата. */
import type { ReactElement } from 'react';
import { Box, Button, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { PackageView } from '@shared/types';
import { isExternalPackage } from '../decisions';

export function PackageResult({
  pkg,
  busy,
  onAccept,
  onContactSheet,
  onSelectImage
}: {
  pkg: PackageView;
  busy: boolean;
  onAccept(): void;
  onContactSheet(): void;
  onSelectImage(index: number): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
  const image = pkg.request?.kind === 'image';
  const canSelectImage = !isExternalPackage(pkg) && !pending && pkg.stage === 'image_downloaded' && !!pkg.resultToken;
  const downloaded = pkg.request?.downloads.length ? pkg.request.downloads : [];
  return (
    <>
      {downloaded.length ? (
        <Box sx={{ mb: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            Результат
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {downloaded.map((path, index) =>
              image ? (
                <Box key={path} sx={{ minWidth: 0, maxWidth: 420 }}>
                  <img
                    src={window.api.shell.fileUrl(path)}
                    alt={`Вариант опорного кадра ${index + 1}`}
                    style={{ width: '100%', maxWidth: 420, borderRadius: 8 }}
                  />
                  <Button
                    startIcon={<CheckCircleIcon />}
                    variant="outlined"
                    sx={{ mt: 1 }}
                    disabled={busy || !canSelectImage}
                    onClick={() => onSelectImage(index)}
                  >
                    Выбрать как опору
                  </Button>
                </Box>
              ) : (
                <video
                  key={path}
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(path)}
                  style={{ width: 420, maxWidth: '100%', borderRadius: 8, background: '#000' }}
                />
              )
            )}
          </Box>
          {image ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Выбор сохраняет оригинал как опору. Утверждение опор выполняется отдельно на следующем этапе.
            </Typography>
          ) : pkg.preview.length ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
              {pkg.preview.map((path) => (
                <img key={path} src={window.api.shell.fileUrl(path)} alt="" style={{ maxWidth: 420, borderRadius: 6 }} />
              ))}
            </Box>
          ) : (
            <Button startIcon={<GridViewIcon />} size="small" sx={{ mt: 1 }} onClick={onContactSheet} disabled={busy}>
              Сделать техническую сводку
            </Button>
          )}
          {!image && !isExternalPackage(pkg) && !pending && ['downloaded', 'edit_review'].includes(pkg.stage) ? (
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
              <Button variant="contained" color="error" startIcon={<CheckCircleIcon />} disabled={busy} onClick={onAccept}>
                Принять в assets
              </Button>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </>
  );
}
