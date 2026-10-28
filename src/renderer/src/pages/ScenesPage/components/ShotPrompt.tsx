import type { ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Box, Button, Chip, Typography } from '@mui/material';
import { Prose } from '../../../components/Prose';
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
            <Box sx={{ p: 1, pr: 5, bgcolor: 'action.hover', borderRadius: 1, maxHeight: 220, overflowY: 'auto' }}>
              <Prose text={prompt} />
            </Box>
          </Box>
          {request ? (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {('provider' in request ? `${request.provider} · ` : '') + request.model}
              </Typography>
              {Object.entries(request.parameters).map(([key, value]) => (
                <Chip
                  key={key}
                  size="small"
                  variant="outlined"
                  label={`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`}
                  sx={{ height: 20 }}
                />
              ))}
            </Box>
          ) : null}
          <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => copy(prompt)}>
            Скопировать промпт
          </Button>
        </ShotSection>
      ) : null}
    </>
  );
}
