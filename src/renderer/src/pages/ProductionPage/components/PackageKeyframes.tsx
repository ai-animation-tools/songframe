/** Опоры пакета, их роли, тайминг и состояние согласования. */
import type { ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import type { PackageView } from '@shared/types';

export function PackageKeyframes({ pkg }: { pkg: PackageView }): ReactElement {
  return (
    <>
      {pkg.keyframes.length ? (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Опоры {pkg.timing?.request_seconds ? `· запрос ${pkg.timing.request_seconds} с на окно ${pkg.timing.window_seconds} с` : ''}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            {pkg.keyframes.map((k) => (
              <Box key={k.id} sx={{ width: 220 }}>
                {k.imagePath ? (
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
            ))}
          </Box>
        </Box>
      ) : null}
    </>
  );
}
