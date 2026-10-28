import { useState, type ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Box, ButtonBase, Typography } from '@mui/material';
import { ImageGallery } from '../../../components/ImageGallery';
import { ShotSection } from './ShotSection';

/** Показывает входные опоры сцены с их статусом, а при их отсутствии — карточку аниматика. */
export function ShotInputs({ shot }: { shot: DashboardShot }): ReactElement {
  const asset = shot.asset;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const images = shot.keyframes.length
    ? shot.keyframes.map((keyframe) => ({ imagePath: keyframe.imagePath, label: `${keyframe.label}${keyframe.approved ? '' : ' · кандидат'}` }))
    : shot.cardPath
      ? [{ imagePath: shot.cardPath, label: `Карточка аниматика · ${shot.id}` }]
      : [];
  return (
    <>
      {shot.keyframes.length ? (
        <ShotSection title={asset ? 'Входы принятого запроса' : 'Опоры пакета'}>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {shot.keyframes.map((k, index) => (
              <Box key={`${k.imagePath}-${index}`} sx={{ width: 150 }}>
                <ButtonBase
                  onClick={() => setActiveIndex(index)}
                  aria-label={`Открыть изображение: ${images[index].label}`}
                  sx={{ width: '100%', borderRadius: 1, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
                >
                  <img
                    src={window.api.shell.fileUrl(k.imagePath)}
                    alt={k.label}
                    style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', borderRadius: 4, display: 'block', opacity: k.approved ? 1 : 0.7 }}
                  />
                </ButtonBase>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  {images[index].label}
                </Typography>
              </Box>
            ))}
          </Box>
        </ShotSection>
      ) : shot.cardPath ? (
        <ShotSection title="Карточка аниматика">
          <ButtonBase
            onClick={() => setActiveIndex(0)}
            aria-label={`Открыть карточку аниматика: ${shot.id}`}
            sx={{
              width: '100%',
              maxWidth: 480,
              borderRadius: 1,
              '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
            }}
          >
            <img src={window.api.shell.fileUrl(shot.cardPath)} alt={shot.id} style={{ width: '100%', borderRadius: 4, display: 'block' }} />
          </ButtonBase>
        </ShotSection>
      ) : null}
      {activeIndex !== null && images.length > 0 && (
        <ImageGallery kind="Входное изображение" images={images} initialIndex={activeIndex} onClose={() => setActiveIndex(null)} />
      )}
    </>
  );
}
