import { useEffect, useState } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useLocation } from 'react-router-dom';
import type { PreviewInput } from '@shared/workspace';
import { workspaceTexts as text } from '@shared/texts/workspace';
import type { WorkspaceBridge } from '@platform/workspace';
import { MediaPlayer } from '../../components/MediaPlayer';
import { ActionButton } from '../../components/ActionButton';

/** Отдельное окно получает выбранное медиа из Go по session, сообщает loadedmetadata и не владеет проектом. */
export function PreviewPage({ bridge }: { bridge: WorkspaceBridge }) {
  const { search } = useLocation();
  const session = new URLSearchParams(search).get('session') ?? '';
  const [input, setInput] = useState<PreviewInput | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setInput(null);
    setError('');
    void bridge.preview(session).then(
      (value) => {
        if (!disposed) setInput(value);
      },
      (reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : text.unknownError);
      }
    );
    return () => {
      disposed = true;
    };
  }, [bridge, session]);
  const kind = input && /\.(mp4|webm)$/i.test(new URL(input.mediaUrl).pathname) ? 'video' : 'audio';
  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h5" component="h1">
          {input?.title ?? text.previewTitle}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {input && (
          <MediaPlayer
            key={input.mediaUrl}
            bridge={bridge}
            preview={false}
            media={{ path: input.title, url: input.mediaUrl, kind }}
            onMetadata={() => {
              void bridge.previewReady(session).catch((reason) => setError(reason instanceof Error ? reason.message : text.unknownError));
            }}
          />
        )}
        <ActionButton
          startIcon={<CloseIcon />}
          onClick={() => {
            void bridge.closePreview(session).catch((reason) => setError(reason instanceof Error ? reason.message : text.unknownError));
          }}
        >
          {text.closePreview}
        </ActionButton>
      </Stack>
    </Box>
  );
}
