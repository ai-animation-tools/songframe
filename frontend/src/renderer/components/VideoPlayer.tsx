import { componentsTexts } from '@shared/texts/components';
/**
 * Видео результата во всю ширину шага с кнопкой «На весь экран»: полный экран — общий просмотр
 * приложения (useVideoFullscreen), положение и звук переходят в него и обратно. Ссылка на элемент нужна переходам по таймкодам.
 * version добавляется к адресу, когда файл по тому же пути пересобирается: WebView не покажет прежний.
 * actions — действия с этим видео в одной строке с «На весь экран»: рядом с двумя плеерами видно,
 * к какому из них кнопка относится.
 */
import { useRef, type ReactElement, type ReactNode, type Ref } from 'react';
import { Box, Button, Stack } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import { useVideoFullscreen } from './VideoFullscreen';

export function VideoPlayer({
  path,
  videoRef,
  version,
  label,
  actions
}: {
  path: string;
  videoRef?: Ref<HTMLVideoElement>;
  version?: string;
  label?: string;
  actions?: ReactNode;
}): ReactElement {
  const element = useRef<HTMLVideoElement | null>(null);
  const fullscreen = useVideoFullscreen(() => element.current, label);
  return (
    <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
      <video
        ref={(node) => {
          element.current = node;
          if (typeof videoRef === 'function') videoRef(node);
          else if (videoRef) (videoRef as { current: HTMLVideoElement | null }).current = node;
        }}
        controls
        preload="metadata"
        aria-label={label}
        src={version ? `${window.api.shell.fileUrl(path)}?v=${encodeURIComponent(version)}` : window.api.shell.fileUrl(path)}
        style={{ width: '100%', display: 'block', borderRadius: 8, background: '#000' }}
      />
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="small" startIcon={<FullscreenIcon />} onClick={fullscreen.open}>
          {componentsTexts.videoPlayer.fullscreen}
        </Button>
        {actions}
      </Stack>
      {fullscreen.dialog}
    </Box>
  );
}
