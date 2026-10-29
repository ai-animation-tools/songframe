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
      <Typography variant="subtitle2">Замечания к опорам · {active.length}</Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
        Агент получает их в задании создания опоры. Замечание «только Kxx» учитывается при создании этой опоры, «Kxx и следующие» — также при создании всех
        следующих опор пакета.
        {inactive ? ` Снятых замечаний: ${inactive}, они больше не передаются.` : ''}
      </Typography>
      <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {active.map((note) => {
          const target = note.frame ?? 'все';
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
                      ? `${note.frame} и следующие опоры`
                      : 'все опоры'
                    : note.frame
                      ? `только ${note.frame}`
                      : 'только одна опора'}
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
                aria-label={note.frame ? `Снять замечание к ${note.frame}` : 'Снять замечание ко всем опорам'}
                title="Снять замечание: агент перестанет его получать"
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
