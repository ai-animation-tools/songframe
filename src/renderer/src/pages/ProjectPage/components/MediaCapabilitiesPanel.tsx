/** Проверка возможностей читает сведения провайдера и не отправляет генерацию. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import type { MediaCapabilities } from '@shared/media-providers';

export function MediaCapabilitiesPanel({
  project,
  kind,
  provider,
  onResult
}: {
  project: string;
  kind: 'image' | 'video';
  provider: string;
  onResult: (value: MediaCapabilities) => void;
}): ReactElement {
  const [result, setResult] = useState<MediaCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const check = useCallback(async (): Promise<void> => {
    const current = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.media.capabilities(project, kind, provider);
      if (request.current !== current) return;
      setResult(next);
      onResult(next);
    } catch (cause) {
      if (request.current !== current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === current) setBusy(false);
    }
  }, [project, kind, provider, onResult]);

  useEffect(() => {
    // Подсказки заполняются при открытии карточки. Поздний ответ другой формы не меняет текущие варианты.
    setResult(null);
    if (provider) void check();
    return () => {
      request.current += 1;
    };
  }, [provider, check]);

  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        Читает через CLI доступные модели и параметры текущего провайдера и обновляет подсказки. Не сохраняет форму, не запускает генерацию и не списывает
        кредиты.
      </Typography>
      {error && <Alert severity="error">Не удалось проверить возможности: {error}</Alert>}
      {result && (
        <Alert severity={result.available && result.problems.length === 0 ? 'info' : 'warning'}>
          <Typography variant="body2">
            {result.available
              ? result.problems.length > 0
                ? 'Получена только часть возможностей провайдера. Обновите возможности.'
                : 'Провайдер доступен.'
              : 'Провайдер недоступен.'}
          </Typography>
          {result.problems.map((problem, index) => (
            <Typography key={`${index}:${problem}`} variant="body2">
              {problem}
            </Typography>
          ))}
          {!result.generationVerified && (
            <Typography variant="body2">
              {result.provider === 'codex'
                ? 'Проверка не создаёт изображений. Доступность встроенного генератора выясняется при согласованной генерации.'
                : 'Эта проверка не подтверждает выполнение генерации. Параметры и доступ к модели проверяют перед запросом.'}
            </Typography>
          )}
          {result.models.length > 0 && (
            <Typography variant="body2">Модели: {result.models.map((model) => `${model.id} (${model.command})`).join(', ')}.</Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            Проверено: {result.checkedAt}
          </Typography>
        </Alert>
      )}
      <Button
        startIcon={<SyncIcon />}
        variant="contained"
        size="small"
        disabled={busy || !provider}
        onClick={() => {
          void check();
        }}
        sx={{ alignSelf: 'start' }}
      >
        {busy ? 'Проверяем возможности' : result ? 'Обновить возможности' : 'Проверить возможности'}
      </Button>
    </Stack>
  );
}
