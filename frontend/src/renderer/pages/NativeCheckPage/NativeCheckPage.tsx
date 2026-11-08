import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/material';
import { runNativeCheck, type NativeObservation } from '@platform/native-check';

/** Служебная страница существует только для явно запущенной нативной проверки.
 * Отображает реальные наблюдения WebView; результат пишет Go-сервис режима проверки.
 */
export function NativeCheckPage() {
  const host = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [checks, setChecks] = useState<NativeObservation[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!host.current || started.current) return;
    started.current = true;
    void runNativeCheck(host.current, setChecks).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  return (
    <Stack spacing={2} sx={{ p: 3 }}>
      <Typography variant="h5" component="h1">
        Нативная проверка SongFrame
      </Typography>
      <Alert severity="info">Синтетические медиа проверяются без звука. Физическое воспроизведение проверяется отдельно человеком.</Alert>
      {error && <Alert severity="error">{error}</Alert>}
      <Box ref={host} />
      {checks.map((item) => (
        <Alert key={item.name} severity={item.passed ? 'success' : 'error'}>
          {item.name}: {item.details}
        </Alert>
      ))}
    </Stack>
  );
}
