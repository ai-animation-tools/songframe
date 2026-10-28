/** Опоры пакета, их роли, тайминг и состояние согласования; щелчок открывает изображение в общей галерее. */
import { useState, type ReactElement } from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';
import { ImageGallery } from '../../../components/ImageGallery';

export function PackageKeyframes({ pkg }: { pkg: PackageView }): ReactElement {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const images = pkg.keyframes
    .filter((k) => k.imagePath)
    .map((k) => ({ imagePath: k.imagePath!, label: `${k.id} · ${k.role} · ${k.time_seconds} с · ${k.approved ? 'принята' : 'кандидат'}` }));
  return (
    <>
      {pkg.keyframes.length ? (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Опоры {pkg.timing?.request_seconds ? `· запрос ${pkg.timing.request_seconds} с на окно ${pkg.timing.window_seconds} с` : ''}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            {pkg.keyframes.map((k) => {
              const index = images.findIndex((image) => image.imagePath === k.imagePath);
              return (
                <Box key={k.id} sx={{ width: 220 }}>
                  {k.imagePath ? (
                    <ButtonBase
                      onClick={() => setActiveIndex(index)}
                      aria-label={`Открыть опору ${k.id}`}
                      sx={{ width: '100%', borderRadius: 1.5, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
                    >
                      <img
                        src={window.api.shell.fileUrl(k.imagePath)}
                        alt={k.id}
                        style={{
                          width: '100%',
                          aspectRatio: '16/9',
                          objectFit: 'cover',
                          borderRadius: 6,
                          display: 'block',
                          outline: k.approved ? '2px solid #2e7d32' : '2px dashed #ef6c00'
                        }}
                      />
                    </ButtonBase>
                  ) : (
                    <Box sx={{ width: '100%', aspectRatio: '16/9', bgcolor: 'action.hover', borderRadius: 1.5 }} />
                  )}
                  <Typography variant="caption" display="block">
                    {k.id} · {k.role} · {k.time_seconds} с · {k.approved ? 'принята' : k.imagePath ? 'кандидат' : 'нет файла'}
                  </Typography>
                  {k.note ? (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {k.note}
                    </Typography>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
      {activeIndex !== null && images.length ? (
        <ImageGallery kind="Опора" images={images} initialIndex={activeIndex} onClose={() => setActiveIndex(null)} />
      ) : null}
    </>
  );
}
