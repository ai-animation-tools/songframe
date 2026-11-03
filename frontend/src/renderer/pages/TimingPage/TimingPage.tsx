import { useMemo, useState } from 'react';
import { Alert, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import type { MediaFile, ProjectSnapshot } from '@shared/workspace';
import { analyzeLyrics, selectLyricTimings } from '@shared/lyrics';
import { workspaceTexts as text } from '@shared/texts/workspace';
import type { WorkspaceBridge } from '@platform/workspace';
import type { ComponentsApi } from '@platform/components';
import { ComponentsNotice } from './components/ComponentsNotice';
import { ActionButton } from '../../components/ActionButton';
import { MediaPlayer, type SeekRequest } from '../../components/MediaPlayer';
import { NativeDropZone } from '../../components/NativeDropZone';
import { PageActionBar } from '../../components/PageActionBar';

/** Просмотр связывает тайминги с физическими строками текста, включая пропуски и заголовки.
 * Нет преобразования, редактирования или сохранения: verified, ручные части и заметки показываются из снимка.
 */
export function TimingPage({
  snapshot,
  media,
  bridge,
  componentsApi,
  busy,
  onRefresh,
  onClose,
  onPickMedia
}: {
  snapshot: ProjectSnapshot;
  media: MediaFile | null;
  bridge: WorkspaceBridge;
  componentsApi: ComponentsApi;
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onPickMedia: () => void;
}) {
  const lyrics = useMemo(() => analyzeLyrics(snapshot.lyricsText), [snapshot.lyricsText]);
  const timings = useMemo(
    () => new Map(selectLyricTimings(snapshot.timing?.lines ?? [], lyrics.rows).lines.map((line) => [line.source_line, line])),
    [snapshot.timing, lyrics.rows]
  );
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  // SHA из manifest меняется при замене исходника: старый buffer и запрос прослушивания больше не относятся к треку.
  const mediaVersion = media?.path === snapshot.track?.path ? (snapshot.trackSha256 ?? '') : '';
  const mediaIdentity = `${media?.url ?? ''}:${mediaVersion}`;
  return (
    <Stack spacing={2}>
      <PageActionBar title={text.timeline}>
        <Chip size="small" label={text.readOnly} />
        <ActionButton startIcon={<RefreshIcon />} onClick={onRefresh} disabled={busy}>
          {text.refresh}
        </ActionButton>
        <ActionButton startIcon={<CloseIcon />} onClick={onClose}>
          {text.closeProject}
        </ActionButton>
      </PageActionBar>
      <Typography variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
        {snapshot.name}
      </Typography>
      <Alert severity="info">{text.readOnlyHint}</Alert>
      <ComponentsNotice api={componentsApi} />
      {snapshot.blocked && <Alert severity="error">{text.blocked}</Alert>}
      {snapshot.problems.map((problem, index) => (
        <Alert severity="warning" key={index}>
          {problem}
        </Alert>
      ))}
      {!snapshot.blocked && (
        <>
          {media ? (
            <MediaPlayer key={mediaIdentity} media={media} mediaVersion={mediaVersion} bridge={bridge} seek={seek} />
          ) : (
            <Alert severity="info">{text.missingMedia}</Alert>
          )}
          <NativeDropZone id="media-drop" title={text.dropMedia} hint={text.dropMediaHint} onPick={onPickMedia} disabled={busy} />
          {!snapshot.timing && <Alert severity="info">{text.noTiming}</Alert>}
          {lyrics.problems.map((problem, index) => (
            <Alert key={index} severity="warning">
              {problem}
            </Alert>
          ))}
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label={text.timeline}>
              <TableHead>
                <TableRow>
                  <TableCell>{text.sourceLine}</TableCell>
                  <TableCell>{text.lyrics}</TableCell>
                  <TableCell>{text.start}</TableCell>
                  <TableCell>{text.end}</TableCell>
                  <TableCell>{text.verification}</TableCell>
                  <TableCell>{text.note}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {lyrics.rows
                  .filter((row) => row.text)
                  .map((row) => {
                    const timing = timings.get(row.number);
                    return (
                      <TableRow key={row.number} sx={row.header ? { bgcolor: 'action.hover' } : undefined}>
                        <TableCell>{row.number}</TableCell>
                        <TableCell sx={{ maxWidth: 400, overflowWrap: 'anywhere', fontWeight: row.header ? 700 : 400 }}>{row.text}</TableCell>
                        <TableCell>{timing?.start ?? text.noBoundary}</TableCell>
                        <TableCell>{timing?.end ?? text.noBoundary}</TableCell>
                        <TableCell>
                          {timing ? (
                            <Chip size="small" label={timing.verified ? text.verified : text.unverified} color={timing.verified ? 'success' : 'default'} />
                          ) : (
                            text.noBoundary
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{timing?.note}</TableCell>
                        <TableCell>
                          {timing && (
                            <ActionButton
                              aria-label={text.playLine(row.number)}
                              title={text.playLine(row.number)}
                              disabled={!media || timing.end <= timing.start || timing.start < 0}
                              disabledReason={!media ? text.missingMedia : null}
                              onClick={() => setSeek({ mediaIdentity, start: timing.start, end: timing.end, sequence: (seek?.sequence ?? 0) + 1 })}
                              sx={{ minWidth: 36 }}
                            >
                              <PlayArrowIcon />
                            </ActionButton>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </TableContainer>
          {snapshot.timing && snapshot.timing.sections && snapshot.timing.sections.length > 0 && (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h6" component="h2">
                {text.sections}
              </Typography>
              <Stack spacing={1} sx={{ mt: 2 }}>
                {snapshot.timing.sections.map((section, index) => (
                  <Stack key={index} direction="row" gap={2} flexWrap="wrap">
                    <Typography>{section.name}</Typography>
                    <Typography>
                      {section.start}–{section.end}
                    </Typography>
                    <Chip size="small" label={section.origin === 'manual' ? text.manual : text.automatic} />
                    {section.note && <Typography>{section.note}</Typography>}
                  </Stack>
                ))}
              </Stack>
            </Paper>
          )}
        </>
      )}
    </Stack>
  );
}
