/** Отчёт остаётся советом: наблюдения открывают кадры и перематывают оригинал, приёмка живёт в PackageResult. */
import { useState, type ReactElement } from 'react';
import { Alert, Box, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { VideoReviewView } from '@shared/video-review';
import { videoReviewTexts as texts } from '@shared/texts/video-review';
import { AgentButton } from '../../../components/AgentButton';
import { ActionButton } from '../../../components/ActionButton';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { LinkedText } from '../../../components/LinkedText';
import { formatClock } from '../../../format';
import { useVideoReview } from '../useVideoReview';

export interface VideoReviewPanelContentProps {
  view: VideoReviewView | null;
  error: string | null;
  pending: boolean;
  refreshing?: boolean;
  disabledReason?: string | null;
  onStart(): void;
  onCancel(): void;
  onRefresh(): void;
  onSeek(timeSeconds: number): void;
}

/** Управляемый блок позволяет проверять реальные состояния без запуска агента или доступа к файлам. */
export function VideoReviewPanelContent({
  view,
  error,
  pending,
  refreshing = false,
  disabledReason,
  onStart,
  onCancel,
  onRefresh,
  onSeek
}: VideoReviewPanelContentProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [gallery, setGallery] = useState<{ images: { imagePath: string; label: string }[]; index: number } | null>(null);
  const running = view?.status === 'running' || view?.status === 'preparing';
  const reason = pending ? texts.pending : running ? texts.runningReason : (disabledReason ?? (!view ? texts.loading : !view.canStart ? view.reason : null));
  const report = view?.report;
  const images = (view?.frames ?? []).map((frame) => ({ imagePath: frame.path, label: texts.frame({ id: frame.id, time: formatClock(frame.timeSeconds) }) }));
  const message = error ?? view?.error;
  return (
    <Paper component="section" aria-label={texts.heading} variant="outlined" sx={{ p: 2, mt: 2, minWidth: 0 }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle2" component="h3">
            {texts.heading}
          </Typography>
          {view && (
            <Chip
              size="small"
              label={texts.status[view.status]}
              color={view.status === 'failed' ? 'error' : view.status === 'completed' ? 'success' : 'default'}
            />
          )}
          {(running || (!view && !message)) && <CircularProgress size={18} aria-label={view ? texts.status[view.status] : texts.loading} />}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {texts.description}
        </Typography>
        {view?.stale && (
          <Alert severity="warning">
            <LinkedText text={texts.main.stale} />
          </Alert>
        )}
        {view?.durationSeconds !== null && view?.durationSeconds !== undefined && (
          <Typography variant="caption" color="text.secondary">
            {texts.duration({ seconds: view.durationSeconds.toFixed(2).replace('.', ',') })}
          </Typography>
        )}
        {report ? (
          <>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {report.summary}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {texts.timeHint}
            </Typography>
            {!report.findings.length && (
              <Typography variant="body2" color="text.secondary">
                {texts.noFindings}
              </Typography>
            )}
            {(expanded ? report.findings : report.findings.slice(0, 3)).map((finding, index) => {
              const color = finding.verdict === 'match' ? 'success' : finding.verdict === 'mismatch' ? 'error' : 'warning';
              const icon =
                finding.verdict === 'match' ? <CheckCircleOutlineIcon /> : finding.verdict === 'mismatch' ? <ErrorOutlineIcon /> : <HelpOutlineIcon />;
              return (
                <Box key={index} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                    <Chip size="small" color={color} icon={icon} label={texts.verdict[finding.verdict]} />
                    <ActionButton
                      size="small"
                      startIcon={<PlayArrowIcon />}
                      onClick={() => onSeek(finding.timeSeconds)}
                      aria-label={texts.seek({ time: formatClock(finding.timeSeconds) })}
                      title={texts.seek({ time: formatClock(finding.timeSeconds) })}
                    >
                      {formatClock(finding.timeSeconds)}
                    </ActionButton>
                  </Box>
                  <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {finding.description}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                    {finding.frameIds.map((id) => {
                      const frameIndex = view!.frames.findIndex((frame) => frame.id === id);
                      if (frameIndex < 0) return null;
                      const frame = view!.frames[frameIndex];
                      return (
                        <Box key={id} sx={{ width: 176, maxWidth: '100%' }}>
                          <ImageThumbnail path={frame.path} label={images[frameIndex].label} onOpen={() => setGallery({ images, index: frameIndex })} />
                          <Typography variant="caption" color="text.secondary">
                            {images[frameIndex].label}
                          </Typography>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              );
            })}
            {report.findings.length > 3 && (
              <Box>
                <ActionButton
                  startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? texts.showLess : texts.showAll}
                </ActionButton>
              </Box>
            )}
            {!!report.limitations.length && (
              <Box>
                <Typography variant="subtitle2">{texts.limitations}</Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {report.limitations.map((limitation, index) => (
                    <Typography component="li" variant="body2" key={index} sx={{ overflowWrap: 'anywhere' }}>
                      {limitation}
                    </Typography>
                  ))}
                </Box>
              </Box>
            )}
          </>
        ) : (
          !running &&
          view && (
            <Typography variant="body2" color="text.secondary">
              {texts.empty}
            </Typography>
          )
        )}
        {message && (
          <Alert severity="error">
            <LinkedText text={message} />
          </Alert>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <AgentButton
            variant="contained"
            disabled={!!reason || !view?.canStart}
            disabledReason={reason}
            onClick={onStart}
            provider={running ? view?.job?.provider : undefined}
          >
            {report || view?.status === 'failed' || view?.status === 'cancelled' ? texts.repeat : texts.start}
          </AgentButton>
          {running && (
            <ActionButton startIcon={<CancelOutlinedIcon />} disabled={pending} disabledReason={texts.pending} onClick={onCancel}>
              {texts.cancel}
            </ActionButton>
          )}
          {!running && (
            <ActionButton
              startIcon={refreshing ? <CircularProgress size={16} color="inherit" aria-label={texts.refreshing} /> : <RefreshIcon />}
              disabled={pending}
              disabledReason={texts.pending}
              title={texts.refreshHint}
              onClick={onRefresh}
            >
              {texts.refresh}
            </ActionButton>
          )}
        </Box>
      </Stack>
      {gallery && <ImageGallery kind={texts.galleryKind} images={gallery.images} initialIndex={gallery.index} onClose={() => setGallery(null)} />}
    </Paper>
  );
}

export function VideoReviewPanel({ packageDir, onSeek }: { packageDir: string; onSeek(timeSeconds: number): void }): ReactElement {
  const review = useVideoReview(packageDir);
  return (
    <VideoReviewPanelContent
      view={review.view}
      error={review.error}
      pending={review.pending}
      refreshing={review.refreshing}
      disabledReason={review.projectAvailable ? null : texts.noProject}
      onStart={() => void review.start()}
      onCancel={() => void review.cancel()}
      onRefresh={() => void review.refresh()}
      onSeek={onSeek}
    />
  );
}
