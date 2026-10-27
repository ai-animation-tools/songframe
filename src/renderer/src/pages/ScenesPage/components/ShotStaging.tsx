import type { ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Box, Chip, Stack, Typography } from '@mui/material';
import { ShotSection } from './ShotSection';

/** Собирает постановку сцены, заметки и визуальные ссылки на персонажей и окружение. */
export function ShotStaging({ shot }: { shot: DashboardShot }): ReactElement {
  return (
    <>
      <ShotSection title="Постановка">
        <Stack spacing={0.5}>
          {shot.original ? (
            <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
              {shot.original}
            </Typography>
          ) : null}
          <Typography variant="body2">
            <b>Камера.</b> {shot.camera || 'не задана'}
          </Typography>
          <Typography variant="body2">
            <b>Действие.</b> {shot.action || 'не задано'}
          </Typography>
          {shot.continuity ? (
            <Typography variant="body2">
              <b>Связь.</b> {shot.continuity}
            </Typography>
          ) : null}
          {shot.notes ? (
            <Typography variant="body2" color="text.secondary">
              {shot.notes}
            </Typography>
          ) : null}
          {shot.references.length ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>
              {shot.references.map((r) => (
                <Chip
                  key={r.id}
                  size="small"
                  variant="outlined"
                  label={r.name}
                  avatar={
                    r.imagePath ? (
                      <img src={window.api.shell.fileUrl(r.imagePath)} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
                    ) : undefined
                  }
                />
              ))}
            </Box>
          ) : null}
        </Stack>
      </ShotSection>
    </>
  );
}
