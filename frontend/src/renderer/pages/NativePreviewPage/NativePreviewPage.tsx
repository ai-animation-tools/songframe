import { useEffect, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { nativePreview, type NativePreviewInput } from '@platform/native-check';

/** Служебное второе окно нативной проверки (--native-check): получает медиа из Go по session,
 * сообщает loadedmetadata (preview:ready) и закрывается через Go. Служебное окно не входит
 * в контракт window.api и работает через служебный адаптер nativePreview из frontend/src/platform.
 * Видео не приглушается: окно его не воспроизводит, а mute запомнился бы звуковым сервером для роли Movie.
 */
export function NativePreviewPage() {
  const { search } = useLocation();
  const session = new URLSearchParams(search).get('session') ?? '';
  const [input, setInput] = useState<NativePreviewInput | null>(null);
  const [error, setError] = useState('');
  const fail = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => {
    let disposed = false;
    void nativePreview.load(session).then((value) => {
      if (disposed) return;
      if (value) setInput(value);
      else setError('Сеанс второго окна не найден');
    }, fail);
    return () => {
      disposed = true;
    };
  }, [session]);
  return (
    <Stack spacing={2} sx={{ p: 3 }}>
      <Typography variant="h5" component="h1">
        {input?.title ?? 'Второе окно SongFrame'}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {input && (
        <video
          key={input.mediaUrl}
          src={input.mediaUrl}
          controls
          preload="metadata"
          style={{ maxWidth: '100%' }}
          onLoadedMetadata={() => void nativePreview.ready(session).catch(fail)}
        />
      )}
      <Button variant="outlined" onClick={() => void nativePreview.close(session).catch(fail)}>
        Закрыть
      </Button>
    </Stack>
  );
}
