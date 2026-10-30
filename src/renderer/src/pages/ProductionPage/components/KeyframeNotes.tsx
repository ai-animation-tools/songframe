import { productionTexts } from '@shared/texts/production';
/** Действующие замечания к опорам пакета: их получает агент при создании опор; снятое больше не передаётся. */
import type { ReactElement } from 'react';
import NotInterestedIcon from '@mui/icons-material/NotInterested';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { KeyframeNote } from '@shared/types';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { DateTime } from '../../../components/DateTime';

export function KeyframeNotes({
  notes,
  busy,
  busyReason,
  onDeactivate
}: {
  notes: KeyframeNote[];
  busy: boolean;
  busyReason: string;
  onDeactivate(id: number): void;
}): ReactElement | null {
  const active = notes.filter((note) => note.active);
  const inactive = notes.length - active.length;
  if (!active.length) return null;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="subtitle2">{productionTexts.keyframeNotes.heading({ active: active.length })}</Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
        {productionTexts.keyframeNotes.description({ inactive })}
      </Typography>
      <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {active.map((note) => {
          const target = note.frame ?? productionTexts.keyframeNotes.allFrames;
          return (
            <Box
              component="li"
              key={note.id}
              sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1, minWidth: 0 }}
            >
              <Chip size="small" variant="outlined" label={target} sx={{ flexShrink: 0 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {note.note}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {note.scope === 'following'
                    ? note.frame
                      ? productionTexts.keyframeNotes.followingFrames({ frame: note.frame })
                      : productionTexts.keyframeNotes.allFramesLabel
                    : note.frame
                      ? productionTexts.keyframeNotes.singleFrame({ frame: note.frame })
                      : productionTexts.keyframeNotes.singleFrameLabel}
                  {note.at ? (
                    <>
                      {' · '}
                      <DateTime value={note.at} />
                    </>
                  ) : null}
                </Typography>
              </Box>
              <ActionIconButton
                size="small"
                aria-label={note.frame ? productionTexts.keyframeNotes.removeFrame({ frame: note.frame }) : productionTexts.keyframeNotes.removeAll}
                title={productionTexts.keyframeNotes.removeHint}
                disabled={busy}
                disabledReason={busyReason}
                onClick={() => onDeactivate(note.id)}
              >
                <NotInterestedIcon fontSize="small" />
              </ActionIconButton>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
