import { projectTexts } from '@shared/texts/project';
import { SlottedText } from '../../../components/SlottedText';
/** Проверка возможностей читает сведения провайдера и не отправляет генерацию. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import type { MediaCapabilities } from '@shared/media-providers';
import { capabilitiesFailed, capabilitiesNote, capabilitiesSummary } from './capabilitiesSummary';
import { DateTime } from '../../../components/DateTime';
import { useApp } from '../../../state';
import { LinkedText } from '../../../components/LinkedText';

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
  const { online } = useApp();

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
    // Без сети проверка не запускается; при восстановлении связи она выполнится сама.
    setResult(null);
    setError(null);
    if (provider && online) void check();
    return () => {
      request.current += 1;
    };
  }, [provider, check, online]);

  // Проверка идёт сама при открытии и смене провайдера; повтор нужен только после ошибки, недоступности или неполного ответа.
  const failed = capabilitiesFailed(result, error);

  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {projectTexts.capabilities.automaticCheck}
      </Typography>
      {busy && <LinearProgress aria-label={projectTexts.capabilities.checking} />}
      {!online && provider ? <Alert severity="info">{projectTexts.capabilities.checkWhenOnline}</Alert> : null}
      {error && (
        <Alert severity="error">
          <LinkedText text={projectTexts.capabilities.failed({ error })} />
        </Alert>
      )}
      {result && (
        <Alert severity={result.available && result.problems.length === 0 ? 'info' : 'warning'}>
          <Typography variant="body2">{capabilitiesSummary(result)}</Typography>
          {result.problems.map((problem, index) => (
            <Typography key={`${index}:${problem}`} variant="body2">
              <LinkedText text={problem} />
            </Typography>
          ))}
          {!result.generationVerified && <Typography variant="body2">{capabilitiesNote(result)}</Typography>}
          <Typography variant="caption" color="text.secondary">
            <SlottedText text={projectTexts.capabilities.checkedAt} slots={{ date: <DateTime value={result.checkedAt} /> }} />
          </Typography>
        </Alert>
      )}
      {failed && !busy && provider && online ? (
        <Button
          startIcon={<SyncIcon />}
          variant="outlined"
          size="small"
          onClick={() => {
            void check();
          }}
          sx={{ alignSelf: 'start' }}
        >
          {projectTexts.capabilities.retry}
        </Button>
      ) : null}
    </Stack>
  );
}
