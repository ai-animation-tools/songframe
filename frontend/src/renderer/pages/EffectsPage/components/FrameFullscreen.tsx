/**
 * Кадр превью на весь экран: тот же вид, что у полноэкранного видео (VideoFullscreen) — чёрный
 * полноэкранный Dialog, окно приложения разворачивает Go (window.api.shell.setFullscreen). Кадр
 * приходит в полном размере ролика: на уменьшенном превью зерно и тонкие капли усредняются.
 * «До» и «После» переключаются здесь же, чтобы сравнивать кадр в одном масштабе. Выход — Escape
 * или кнопка в углу.
 */
import { useEffect, type ReactElement } from 'react';
import { Alert, Box, CircularProgress, Dialog, IconButton, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { componentsTexts } from '@shared/texts/components';
import { effectsTexts as texts } from '@shared/texts/effects';
import { LinkedText } from '../../../components/LinkedText';
import type { PreviewMode } from '../useEffectsPage';

/** Подложка элементов поверх кадра: читаются на любом изображении. */
const OVERLAY = { bgcolor: 'rgba(0, 0, 0, 0.6)', color: '#fff', borderRadius: 1 } as const;

export function FrameFullscreen({
  url,
  alt,
  loading,
  error,
  mode,
  onMode,
  onClose
}: {
  url: string | null;
  alt: string;
  loading: boolean;
  error: string | null;
  mode: PreviewMode;
  onMode(mode: PreviewMode): void;
  onClose(): void;
}): ReactElement {
  // Окно разворачивается на время просмотра; отказ не мешает: диалог и так занимает всё окно.
  useEffect(() => {
    void window.api.shell.setFullscreen(true).catch(() => undefined);
    return () => void window.api.shell.setFullscreen(false).catch(() => undefined);
  }, []);

  return (
    <Dialog fullScreen open onClose={onClose} slotProps={{ paper: { 'aria-label': texts.frameFullscreen, sx: { bgcolor: '#000', backgroundImage: 'none' } } }}>
      {url ? <Box component="img" src={url} alt={alt} sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} /> : null}
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ position: 'absolute', top: 16, left: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_, next: PreviewMode | null) => next && onMode(next)}
          aria-label={texts.previewCompare}
          sx={{
            ...OVERLAY,
            '& .MuiToggleButton-root': { color: '#fff', borderColor: 'rgba(255, 255, 255, 0.4)' },
            '& .Mui-selected': { bgcolor: 'rgba(255, 255, 255, 0.25) !important' }
          }}
        >
          <ToggleButton value="before">{texts.previewBefore}</ToggleButton>
          <ToggleButton value="after">{texts.previewAfter}</ToggleButton>
        </ToggleButtonGroup>
        {loading ? (
          <Stack direction="row" spacing={1} sx={{ ...OVERLAY, alignItems: 'center', px: 1, py: 0.5 }}>
            <CircularProgress size={14} color="inherit" aria-hidden />
            <Typography variant="caption">{texts.previewLoading}</Typography>
          </Stack>
        ) : null}
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ position: 'absolute', bottom: 16, left: 16, right: 16 }}>
          <LinkedText text={error} />
        </Alert>
      ) : null}
      <IconButton
        onClick={onClose}
        title={componentsTexts.videoFullscreen.exit}
        aria-label={componentsTexts.videoFullscreen.exit}
        sx={{ position: 'absolute', top: 16, right: 16, color: '#fff', bgcolor: 'rgba(0, 0, 0, 0.5)', '&:hover': { bgcolor: 'rgba(0, 0, 0, 0.7)' } }}
      >
        <FullscreenExitIcon />
      </IconButton>
    </Dialog>
  );
}
