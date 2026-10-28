import GridViewIcon from '@mui/icons-material/GridView';
/** Скачанные оригиналы, техническая сводка и действие приёмки результата; изображения открываются в общей галерее. */
import { useState, type ReactElement } from 'react';
import { Box, Button, ButtonBase, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import type { PackageView } from '@shared/types';
import { ImageGallery } from '../../../components/ImageGallery';

const focusRing = { borderRadius: 1.5, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } };

export function PackageResult({
  pkg,
  busy,
  onAccept,
  onContactSheet,
  onSelectImage,
  onReopenQuestion
}: {
  pkg: PackageView;
  busy: boolean;
  onAccept(): void;
  onContactSheet(): void;
  onSelectImage(index: number): void;
  /** Снова задать вопрос о результате, когда прежний ответ уже записан. */
  onReopenQuestion?(): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
  const image = pkg.request?.kind === 'image';
  const canSelectImage = !pending && pkg.stage === 'image_downloaded' && !!pkg.resultToken;
  const downloaded = pkg.request?.downloads.length ? pkg.request.downloads : [];
  const [gallery, setGallery] = useState<{ kind: string; images: { imagePath: string; label: string }[]; index: number } | null>(null);
  const variants = image ? downloaded.map((path, index) => ({ imagePath: path, label: `Вариант опорного кадра ${index + 1}` })) : [];
  const previews = pkg.preview.map((path, index) => ({ imagePath: path, label: `Техническая сводка · ${path.split(/[\\/]/).pop() ?? index + 1}` }));
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
                  <ButtonBase
                    onClick={() => setGallery({ kind: 'Вариант опорного кадра', images: variants, index })}
                    aria-label={`Открыть вариант опорного кадра ${index + 1}`}
                    sx={{ width: '100%', ...focusRing }}
                  >
                    <img
                      src={window.api.shell.fileUrl(path)}
                      alt={`Вариант опорного кадра ${index + 1}`}
                      style={{ width: '100%', maxWidth: 420, borderRadius: 8, display: 'block' }}
                    />
                  </ButtonBase>
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
              {previews.map((preview, index) => (
                <ButtonBase
                  key={preview.imagePath}
                  onClick={() => setGallery({ kind: 'Техническая сводка', images: previews, index })}
                  aria-label={`Открыть: ${preview.label}`}
                  sx={{ maxWidth: 420, ...focusRing }}
                >
                  <img src={window.api.shell.fileUrl(preview.imagePath)} alt={preview.label} style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }} />
                </ButtonBase>
              ))}
            </Box>
          ) : (
            <Button startIcon={<GridViewIcon />} size="small" sx={{ mt: 1 }} onClick={onContactSheet} disabled={busy}>
              Сделать техническую сводку
            </Button>
          )}
          {!image && !pending && ['downloaded', 'edit_review'].includes(pkg.stage) ? (
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
              <Button variant="contained" color="error" startIcon={<CheckCircleIcon />} disabled={busy} onClick={onAccept}>
                Принять в assets
              </Button>
              {onReopenQuestion ? (
                <Button variant="outlined" startIcon={<HelpOutlineIcon />} disabled={busy} onClick={onReopenQuestion}>
                  Вернуть вопрос о результате
                </Button>
              ) : null}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {gallery ? <ImageGallery kind={gallery.kind} images={gallery.images} initialIndex={gallery.index} onClose={() => setGallery(null)} /> : null}
    </>
  );
}
