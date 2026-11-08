import { productionTexts } from '@shared/texts/production';
/**
 * Видео результата во всю ширину шага с кнопкой «На весь экран»: полный экран запрашивается у самого
 * элемента, поэтому положение и звук сохраняются. Ссылка на элемент нужна переходам по таймкодам.
 */
import { useRef, type ReactElement, type Ref } from 'react';
import { Box, Button } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';

export function VideoPlayer({ path, videoRef }: { path: string; videoRef?: Ref<HTMLVideoElement> }): ReactElement {
  const element = useRef<HTMLVideoElement | null>(null);
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
        src={window.api.shell.fileUrl(path)}
        style={{ width: '100%', display: 'block', borderRadius: 8, background: '#000' }}
      />
      <Button size="small" startIcon={<FullscreenIcon />} sx={{ mt: 0.5 }} onClick={() => void element.current?.requestFullscreen()}>
        {productionTexts.videoPlayer.fullscreen}
      </Button>
    </Box>
  );
}
