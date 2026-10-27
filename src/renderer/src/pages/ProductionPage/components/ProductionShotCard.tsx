/** Описание выбранного плана, команда внешнего агента и принятые видео. */
import type { ReactElement } from 'react';
import { Alert, Box, Paper, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ReplayIcon from '@mui/icons-material/Replay';
import type { ShotProduction } from '@shared/types';
import { formatClock } from '../../../format';
import { AiButton } from '../../../components/AiButton';
import { AgentButton } from '../../../components';

export function ProductionShotCard({
  shot,
  busy,
  pythonAvailable,
  onCopy,
  onRegenerate
}: {
  shot: ShotProduction;
  busy: boolean;
  pythonAvailable: boolean;
  onCopy(text: string): void;
  onRegenerate(id: string): void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="h6">{shot.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          {shot.title} · {formatClock(shot.start)}–{formatClock(shot.end)} · {(shot.end - shot.start).toFixed(2)} с{shot.lipsync ? ' · липсинк' : ''}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ mt: 1 }}>
        {shot.original}
      </Typography>
      {shot.asset ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="subtitle2" gutterBottom>
            Принятые материалы
          </Typography>
          {!shot.asset.video ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Файл принятого монтажного видео отсутствует. Приёмка сохранена; восстановите файл перед сборкой с этим видео.
            </Alert>
          ) : null}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {shot.asset.video ? (
              <video controls preload="metadata" src={window.api.shell.fileUrl(shot.asset.video)} style={{ width: 360, borderRadius: 8, background: '#000' }} />
            ) : null}
            {shot.asset.original && shot.asset.original !== shot.asset.video ? (
              <video
                controls
                preload="metadata"
                src={window.api.shell.fileUrl(shot.asset.original)}
                style={{ width: 360, borderRadius: 8, background: '#000' }}
              />
            ) : null}
          </Box>
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
        <Tooltip title="Скопировать команду для агента">
          <AgentButton provider={null} size="small" endIcon={<ContentCopyIcon />} onClick={() => onCopy(`$ai-clip-scene scene=${shot.id}`)}>
            $ai-clip-scene scene={shot.id}
          </AgentButton>
        </Tooltip>
        {shot.state === 'completed' || shot.packages.length ? (
          <Tooltip title="Создать новую попытку по сохранённому запросу без отправки и оплаты">
            <span>
              <AiButton
                aiKind="video"
                size="small"
                color="warning"
                startIcon={<ReplayIcon />}
                disabled={
                  busy || !pythonAvailable || shot.packages.some((pkg) => ['submission_unknown', 'submitting'].includes(pkg.request?.attemptStatus ?? ''))
                }
                onClick={() => onRegenerate(shot.id)}
              >
                Подготовить повтор
              </AiButton>
            </span>
          </Tooltip>
        ) : null}
      </Box>
    </Paper>
  );
}
