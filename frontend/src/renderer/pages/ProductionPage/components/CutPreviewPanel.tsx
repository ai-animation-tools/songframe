import { productionTexts } from '@shared/texts/production';
/**
 * Предпросмотр участка в окне приёмки: ролик, собранный так же, как его примет приёмка
 * (production.cutPreview), под звук окна песни и полоса строк песни под плеером. Полоса
 * показывает, где в окне звучит каждая строка и где сейчас плеер; щелчок по строке переводит
 * плеер к её началу. Показанный ролик относится к параметрам, с которыми его собрали: после
 * правки участка панель предупреждает, что ролик прежний. Сборка — один вызов без доли готовности,
 * поэтому во время неё видны бегущая полоса и прошедшие секунды: окно не выглядит зависшим.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, ButtonBase, CircularProgress, LinearProgress, Stack, Typography } from '@mui/material';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import type { CutPreview } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { VideoPlayer } from '../../../components/VideoPlayer';

export function CutPreviewPanel({
  parameters,
  disabledReason,
  fps,
  onPreview
}: {
  /** Ключ параметров участка: показанный ролик сверяется с ним. */
  parameters: string;
  /** Почему участок сейчас не собрать; null — можно. */
  disabledReason: string | null;
  fps: number;
  onPreview(): Promise<CutPreview>;
}): ReactElement {
  const texts = productionTexts.acceptResultDialog;
  const [shown, setShown] = useState<{ preview: CutPreview; parameters: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  // Секунды сборки: таймер живёт только пока идёт сборка и очищается при её конце или закрытии окна.
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);
  const show = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const preview = await onPreview();
      if (alive.current) setShown({ preview, parameters });
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  const duration = shown ? shown.preview.frames / fps : 0;
  const percent = (seconds: number): number => Math.min(100, Math.max(0, (seconds / duration) * 100));
  const seconds = (value: number): string => (Math.round(value * 100) / 100).toFixed(2).replace('.', ',');
  return (
    <Stack spacing={1}>
      <Box>
        <ActionButton
          size="small"
          variant="outlined"
          startIcon={loading ? <CircularProgress size={16} aria-hidden /> : <PlayCircleOutlineIcon />}
          title={texts.previewHint}
          disabled={!!disabledReason || loading}
          disabledReason={loading ? texts.previewLoading : disabledReason}
          onClick={() => void show()}
        >
          {texts.preview}
        </ActionButton>
      </Box>
      {loading ? (
        <Alert severity="info" sx={{ '& .MuiAlert-message': { flexGrow: 1 } }}>
          {texts.previewProgress({ seconds: elapsed })}
          <LinearProgress sx={{ mt: 1 }} aria-label={texts.previewLoading} />
        </Alert>
      ) : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {shown ? (
        <Box sx={{ maxWidth: 640 }} data-testid="cut-preview">
          {shown.parameters !== parameters ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              {texts.previewStale}
            </Alert>
          ) : null}
          {!shown.preview.audio ? (
            <Alert severity="info" sx={{ mb: 1 }}>
              {texts.previewNoAudio}
            </Alert>
          ) : null}
          <VideoPlayer
            path={shown.preview.path}
            label={texts.previewLabel}
            videoRef={(node) => {
              if (video.current === node) return;
              video.current = node;
              node?.addEventListener('timeupdate', () => setTime(node.currentTime));
            }}
          />
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            {texts.previewLines}
          </Typography>
          {shown.preview.lines.length ? (
            <Box
              role="list"
              aria-label={texts.previewLines}
              sx={{ position: 'relative', height: 28, mt: 0.5, borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden' }}
            >
              {shown.preview.lines.map((line, index) => (
                <ButtonBase
                  key={index}
                  role="listitem"
                  title={texts.previewLine({ text: line.text, start: seconds(Math.max(0, line.start)) })}
                  onClick={() => {
                    if (video.current) video.current.currentTime = Math.max(0, line.start);
                  }}
                  sx={{
                    position: 'absolute',
                    top: 2,
                    bottom: 2,
                    left: `${percent(line.start)}%`,
                    width: `${Math.max(1, percent(line.end) - percent(line.start))}%`,
                    px: 0.5,
                    borderRadius: 0.5,
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    justifyContent: 'flex-start',
                    overflow: 'hidden'
                  }}
                >
                  <Typography variant="caption" noWrap>
                    {line.text}
                  </Typography>
                </ButtonBase>
              ))}
              <Box
                aria-hidden
                sx={{ position: 'absolute', top: 0, bottom: 0, left: `${percent(time)}%`, width: 2, bgcolor: 'error.main', pointerEvents: 'none' }}
              />
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {shown.preview.lyricProblem ?? texts.previewNoLines}
            </Typography>
          )}
        </Box>
      ) : null}
    </Stack>
  );
}
