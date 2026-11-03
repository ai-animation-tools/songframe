import { montageTexts } from '@shared/texts/montage';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import type { MontageWindowState } from '@shared/montage-window';
import { MontagePreview, MontageShortcuts } from '../MontagePage/components';
import { useThemeMode } from '../../theme';

/** Отдельное окно воспроизводит несохранённый монтаж из основного окна, не создавая второй черновик. */
export function MontagePlayerPage(): ReactElement {
  const [state, setState] = useState<MontageWindowState | null>(null);
  const [frame, setFrame] = useState(0);
  const [command, setCommand] = useState<{ id: number; action: 'toggle' | 'previousFrame' | 'nextFrame' } | null>(null);
  const lastSeek = useRef<number | null>(null);
  const { setMode } = useThemeMode();

  useEffect(() => {
    const unsubscribe = window.api.montageWindow.onMessage(({ message }) => {
      if (message.type === 'state') {
        // Обычное обновление монтажа не должно перематывать собственные часы плеера.
        if (lastSeek.current !== message.state.seekVersion) {
          lastSeek.current = message.state.seekVersion;
          setFrame(message.state.frame);
        }
        setState((current) => ({
          ...message.state,
          // IPC создаёт новые объекты: настройки плеера не должны выглядеть как изменение монтажа и останавливать проверку стыка.
          draft: {
            ...message.state.draft,
            clips:
              current && JSON.stringify(current.draft.clips) === JSON.stringify(message.state.draft.clips) ? current.draft.clips : message.state.draft.clips
          }
        }));
        setMode(message.state.theme);
      } else if (message.type === 'command') {
        setCommand((previous) => ({ id: (previous?.id ?? 0) + 1, action: message.action }));
      }
    });
    window.api.montageWindow.send({ type: 'ready' });
    return unsubscribe;
  }, [setMode]);

  const onFrame = useCallback((value: number) => {
    setFrame(value);
    window.api.montageWindow.send({ type: 'frame', frame: value });
  }, []);
  const onMetadata = useCallback((path: string, frames: number) => window.api.montageWindow.send({ type: 'metadata', path, frames }), []);
  const onTrackFrames = useCallback((frames: number) => window.api.montageWindow.send({ type: 'trackFrames', frames }), []);
  const onPreferences = useCallback((loop: boolean, volume: number) => {
    setState((current) => (current ? { ...current, loop, volume } : current));
    window.api.montageWindow.send({ type: 'preferences', loop, volume });
  }, []);

  if (!state) return <Typography sx={{ p: 2 }}>{montageTexts.waitingDraft}</Typography>;
  return (
    <Box sx={{ p: 1.5, minWidth: 0 }}>
      <MontagePreview
        project={state.project}
        draft={state.draft}
        trackUrl={state.trackUrl}
        frame={frame}
        seekVersion={state.seekVersion}
        selectedClipId={state.selectedClipId}
        suspended={state.suspended}
        suspendedReason={montageTexts.detachedSuspended}
        loop={state.loop}
        volume={state.volume}
        onPreferences={onPreferences}
        command={command}
        onFrame={onFrame}
        onMetadata={onMetadata}
        onTrackFrames={onTrackFrames}
        videoMaxWidth="min(100%, max(200px, calc((100vh - 150px) * 1.7778)))"
      />
      <Box sx={{ mt: 1 }}>
        <MontageShortcuts />
      </Box>
    </Box>
  );
}
