import type { ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Box, Button, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useApp } from '../../../state';
import { ShotSection } from './ShotSection';

/** Показывает промпт и параметры принятого запроса либо пакета и позволяет скопировать текст. */
export function ShotPrompt({ shot }: { shot: DashboardShot }): ReactElement {
  const { notify } = useApp();
  const asset = shot.asset;
  const prompt = asset?.prompt ?? shot.package?.prompt ?? null;
  const request = asset?.request ?? shot.package?.request ?? null;
  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    notify('Скопировано', 'success');
  };

  return (
    <>
      {prompt ? (
        <ShotSection title={asset ? 'Промпт принятой генерации' : 'Видеопромпт пакета'}>
          <Box sx={{ position: 'relative' }}>
            <Typography
              component="pre"
              variant="body2"
              sx={{
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                m: 0,
                p: 1,
                pr: 5,
                bgcolor: 'action.hover',
                borderRadius: 1,
                maxHeight: 220,
                overflowY: 'auto'
              }}
            >
              {prompt}
            </Typography>
          </Box>
          {request ? (
            <Typography variant="caption" color="text.secondary">
              {('provider' in request ? `${request.provider} · ` : '') + request.model} · {JSON.stringify(request.parameters)}
            </Typography>
          ) : null}
          <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => copy(prompt)}>
            Скопировать промпт
          </Button>
        </ShotSection>
      ) : null}
    </>
  );
}
